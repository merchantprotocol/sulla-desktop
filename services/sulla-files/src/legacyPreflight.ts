import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type pg from 'pg';

export interface LegacyPreflightStatus {
  state: 'clear' | 'secure-import-required';
  protectedPrefix?: string;
  code?: 'FILES_LEGACY_SECURE_IMPORT_REQUIRED';
  action?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = /^[0-9a-f]{2}$/i;
const CHUNK = /^[0-9a-f]{64}$/i;

async function regular(path:string, size?:number):Promise<boolean> {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink() && (size === undefined || info.size === size) } catch { return false }
}

async function directory(path:string):Promise<boolean> {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink() } catch { return false }
}

async function rootEntry(root:string, expected:string, caseInsensitive:boolean):Promise<string | undefined> {
  try {
    const entry = (await readdir(root, { withFileTypes: true })).find(item => caseInsensitive ? item.name.toLowerCase() === expected.toLowerCase() : item.name === expected);
    return entry?.name;
  } catch { return undefined }
}

async function hasLegacyChunkShape(chunksRoot:string, externalIds:string[]):Promise<boolean> {
  for (const id of externalIds.filter(value => UUID.test(value)).slice(0, 256)) {
    const collection = join(chunksRoot, id);
    if (!await directory(collection)) continue;
    const buckets = await readdir(collection, { withFileTypes: true }).catch(() => []);
    for (const bucket of buckets.slice(0, 256)) {
      if (!bucket.isDirectory() || !BUCKET.test(bucket.name)) continue;
      const chunks = await readdir(join(collection, bucket.name), { withFileTypes: true }).catch(() => []);
      if (chunks.some(chunk => chunk.isFile() && CHUNK.test(chunk.name))) return true;
    }
  }
  return false;
}

/** Metadata-only classification. No legacy key or chunk content is opened. */
export async function runLegacyPreflight(db:pg.Pool, filesRoot:string, options:{ caseInsensitive?:boolean } = {}):Promise<LegacyPreflightStatus> {
  const previous = (await db.query('SELECT state,protected_prefix FROM files_legacy_preflight WHERE id=TRUE')).rows[0];
  const caseInsensitive = options.caseInsensitive ?? false;
  const chunksName = await rootEntry(filesRoot, 'chunks', caseInsensitive);
  const masterName = await rootEntry(filesRoot, 'master.key', caseInsensitive);
  const externalIds = (await db.query("SELECT id::text FROM collections WHERE compatibility_state='legacy-external-data'")).rows.map(row => String(row.id));
  const chunksRoot = chunksName ? join(filesRoot, chunksName) : '';
  const masterMarker = Boolean(masterName && await regular(join(filesRoot, masterName), 32));
  const externalLayout = Boolean(chunksName && await directory(chunksRoot) && await hasLegacyChunkShape(chunksRoot, externalIds));
  const detected = externalLayout && (masterMarker || externalIds.length > 0);
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
  return required ? {
    state: 'secure-import-required', protectedPrefix, code: 'FILES_LEGACY_SECURE_IMPORT_REQUIRED',
    action: 'Legacy Files data is preserved in place and contained. Secure import/recovery is required before it can be opened.',
  } : { state: 'clear' };
}

export function isLegacyInternalPath(path:string, status?:LegacyPreflightStatus):boolean {
  if (status?.state !== 'secure-import-required' || !status.protectedPrefix) return false;
  const normalized = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const prefix = status.protectedPrefix.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  return normalized === prefix || normalized.startsWith(`${ prefix }/`);
}
