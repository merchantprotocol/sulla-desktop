import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type pg from 'pg';

export interface LegacyPreflightStatus {
  state:            'clear' | 'secure-import-required';
  protectedPrefix?: string;
  code?:            'FILES_LEGACY_SECURE_IMPORT_REQUIRED';
  action?:          string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = /^[0-9a-f]{2}$/i;
const CHUNK = /^[0-9a-f]{64}$/i;

function missing(error:unknown):boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function rootEntries(root:string) {
  try { return await readdir(root, { withFileTypes: true }) } catch (error) {
    if (missing(error)) return [];
    throw new Error('Legacy Files preflight could not inspect the watched-root metadata', { cause: error });
  }
}

function rootEntry(entries:Awaited<ReturnType<typeof rootEntries>>, expected:string, caseInsensitive:boolean) {
  const matches = entries.filter(item => caseInsensitive ? item.name.toLowerCase() === expected.toLowerCase() : item.name === expected);
  if (matches.length > 1) throw new Error(`Legacy Files preflight found ambiguous ${ expected } root metadata`);
  return matches[0];
}

async function hasLegacyChunkShape(chunksRoot:string):Promise<boolean> {
  let collections;
  try { collections = await readdir(chunksRoot, { withFileTypes: true }) } catch (error) {
    throw new Error('Legacy Files preflight could not inspect chunk-store metadata', { cause: error });
  }
  for (const collection of collections) {
    const id = collection.name.toLowerCase();
    if (!collection.isDirectory() || !UUID.test(id)) continue;
    let buckets;
    try { buckets = await readdir(join(chunksRoot, collection.name), { withFileTypes: true }) } catch (error) {
      throw new Error('Legacy Files preflight could not inspect collection metadata', { cause: error });
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || !BUCKET.test(bucket.name)) continue;
      let chunks;
      try { chunks = await readdir(join(chunksRoot, collection.name, bucket.name), { withFileTypes: true }) } catch (error) {
        throw new Error('Legacy Files preflight could not inspect bucket metadata', { cause: error });
      }
      if (chunks.some(chunk => chunk.isFile() && CHUNK.test(chunk.name))) return true;
    }
  }
  return false;
}

/** Metadata-only classification. No legacy key or chunk content is opened. */
export async function runLegacyPreflight(db:pg.Pool, filesRoot:string, options:{ caseInsensitive?: boolean } = {}):Promise<LegacyPreflightStatus> {
  // Migration 009 establishes this classification, and every unlock repeats it
  // so a late/imported external row can never be mistaken for native material.
  await db.query(`UPDATE collections c SET compatibility_state='legacy-external-data'
    WHERE NOT EXISTS (SELECT 1 FROM files_collection_keys k WHERE k.collection_id=c.id)
      AND (
        c.kind='scratch'
        OR EXISTS (SELECT 1 FROM files f WHERE f.collection_id=c.id AND f.created_by_type='agent-run')
        OR c.encrypted_data_key <> '{}'::jsonb
        OR c.dedup_key_ciphertext <> '{}'::jsonb
      )`);
  const previous = (await db.query('SELECT state,protected_prefix FROM files_legacy_preflight WHERE id=TRUE')).rows[0];
  const caseInsensitive = options.caseInsensitive ?? false;
  const entries = await rootEntries(filesRoot);
  const chunksEntry = rootEntry(entries, 'chunks', caseInsensitive);
  const masterEntry = rootEntry(entries, 'master.key', caseInsensitive);
  const chunksName = chunksEntry?.isDirectory() ? chunksEntry.name : undefined;
  const masterName = masterEntry?.isFile() ? masterEntry.name : undefined;
  const externalIds = (await db.query("SELECT id::text FROM collections WHERE compatibility_state='legacy-external-data'")).rows.map(row => String(row.id));
  const chunksRoot = chunksName ? join(filesRoot, chunksName) : '';
  let masterMarker = false;
  if (masterName) {
    try {
      const info = await lstat(join(filesRoot, masterName));
      masterMarker = info.isFile() && !info.isSymbolicLink() && info.size === 32;
    } catch (error) {
      throw new Error('Legacy Files preflight could not verify master-key metadata', { cause: error });
    }
  }
  // The retired runtime's exact root-level UUID/bucket/hash shape is itself
  // containment evidence. Its master may already be in OS custody/quarantine,
  // and its collection ids may never have reached this database.
  const externalLayout = Boolean(chunksName && await hasLegacyChunkShape(chunksRoot));
  const detected = externalLayout || externalIds.length > 0 || Boolean(masterMarker && chunksName);
  const required = detected || previous?.state === 'secure-import-required';
  const protectedPrefix = required ? String(previous?.protected_prefix || chunksName || 'chunks') : undefined;
  await db.query(`INSERT INTO files_legacy_preflight(id,state,protected_prefix,reason,detected_at,checked_at)
    VALUES(TRUE,$1,$2,$3,CASE WHEN $1='secure-import-required' THEN NOW() ELSE NULL END,NOW())
    ON CONFLICT(id) DO UPDATE SET state=CASE WHEN files_legacy_preflight.state='secure-import-required' THEN files_legacy_preflight.state ELSE EXCLUDED.state END,
      protected_prefix=COALESCE(files_legacy_preflight.protected_prefix,EXCLUDED.protected_prefix),reason=COALESCE(files_legacy_preflight.reason,EXCLUDED.reason),
      detected_at=COALESCE(files_legacy_preflight.detected_at,EXCLUDED.detected_at),checked_at=NOW()`,
  [required ? 'secure-import-required' : 'clear', protectedPrefix ?? null, required ? 'retired-external-chunk-store' : null]);
  if (required && protectedPrefix) {
    await db.query(`INSERT INTO files_protected_files(file_id)
      SELECT f.id FROM files f JOIN watched_folder_state w ON w.file_id=f.id
      WHERE lower(w.path)=lower($1) OR starts_with(lower(w.path),lower($1)||'/') ON CONFLICT DO NOTHING`, [protectedPrefix]);
  }
  return required
    ? {
      state:  'secure-import-required',
      protectedPrefix,
      code:   'FILES_LEGACY_SECURE_IMPORT_REQUIRED',
      action: 'Legacy Files data is preserved in place and contained. Secure import/recovery is required before it can be opened.',
    }
    : { state: 'clear' };
}

export function isLegacyInternalPath(path:string, status?:LegacyPreflightStatus):boolean {
  if (status?.state !== 'secure-import-required' || !status.protectedPrefix) return false;
  const normalized = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const prefix = status.protectedPrefix.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  return normalized === prefix || normalized.startsWith(`${ prefix }/`);
}
