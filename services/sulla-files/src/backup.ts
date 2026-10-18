import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { sha256File, validateAndExtractContainer, writeContainer, type BackupManifest, type BackupObject } from './backup/container.js';
import {
  acquireRestoreLock,
  createCoherentDatabaseSnapshot,
  EPHEMERAL_TABLE_DATA,
  publicationCommitted,
  PublicationOutcomeUnknownError,
  publishDatabase,
  restoreIsolatedDatabase,
  type PublicationIdentity,
  type SchemaEvidence,
} from './backup/database.js';

import type { Config } from './config.js';

const EXTENSION = '.sulla-files-backup';
const RESTORE_WORKSPACE_PREFIX = '.sulla-files-restore-';

interface RestoreState extends PublicationIdentity {
  version:          1;
  phase:            'validated' | 'publishing' | 'chunks-published';
  publicationToken: string;
  stagedIdentity:   DirectoryIdentity;
  targetBefore?:    DirectoryIdentity | null;
}

interface DirectoryIdentity { device: string; inode: string }

function isWithin(parent:string, child:string):boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

async function directoryIsEmpty(path:string):Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Files restore target must be a real directory');
    return (await readdir(path)).length === 0;
  } catch (error:any) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function exists(path:string):Promise<boolean> {
  try { await lstat(path); return true } catch (error:any) { if (error?.code === 'ENOENT') return false; throw error }
}

async function directoryIdentity(path:string):Promise<DirectoryIdentity> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Files restore directory has an unsafe type');
  return { device: String(info.dev), inode: String(info.ino) };
}

function sameIdentity(left:DirectoryIdentity, right:DirectoryIdentity):boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function writeRestoreState(workspace:string, state:RestoreState):Promise<void> {
  const temporary = join(workspace, `.publication-${ process.pid }-${ Date.now() }.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(workspace, 'publication.json'));
  const directory = await open(workspace, 'r'); try { await directory.sync() } finally { await directory.close() }
}

function parseRestoreState(value:unknown):RestoreState {
  const state = value as Partial<RestoreState>;
  const identity = state.stagedIdentity;
  const target = state.targetBefore;
  const validIdentity = (candidate:DirectoryIdentity | null | undefined) => candidate == null || Boolean(/^\d+$/.test(candidate.device) && /^\d+$/.test(candidate.inode));
  if (state?.version !== 1 || !['validated', 'publishing', 'chunks-published'].includes(state.phase ?? '') ||
      typeof state.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(state.archiveSha256 ?? '') ||
      !/^[0-9a-f-]{36}$/.test(state.publicationToken ?? '') || !identity ||
      !/^\d+$/.test(identity.device) || !/^\d+$/.test(identity.inode) || !validIdentity(target) ||
      (state.phase !== 'validated' && target === undefined)) {
    throw new Error('Files restore recovery state is malformed; it was preserved for inspection');
  }
  return state as RestoreState;
}

async function recoverInterruptedPublications(config:Config, selectedArchiveSha256:string):Promise<boolean> {
  const parent = dirname(config.chunkRoot);
  for (const name of (await readdir(parent)).filter(value => value.startsWith(RESTORE_WORKSPACE_PREFIX)).sort()) {
    const workspace = join(parent, name); const info = await lstat(workspace);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Files restore recovery path has an unsafe type');
    const statePath = join(workspace, 'publication.json');
    if (!(await exists(statePath))) throw new Error('Files restore workspace has no durable publication state; it was preserved for inspection');
    const state = parseRestoreState(JSON.parse(await readFile(statePath, 'utf8')));
    if (await publicationCommitted(config.databaseUrl, state)) {
      await rm(workspace, { recursive: true, force: true });
      if (state.archiveSha256 === selectedArchiveSha256) return true;
      continue;
    }
    const stagedChunks = join(workspace, 'validated', 'chunks');
    if (await exists(stagedChunks)) {
      if (!sameIdentity(await directoryIdentity(stagedChunks), state.stagedIdentity)) {
        throw new Error('Files restore staged ciphertext identity changed; recovery artifacts were preserved');
      }
      await rm(workspace, { recursive: true, force: true });
      continue;
    }
    if (state.phase === 'validated') {
      throw new Error('Files restore validated stage is missing; the target was preserved for inspection');
    }
    if (!(await exists(config.chunkRoot)) || !sameIdentity(await directoryIdentity(config.chunkRoot), state.stagedIdentity)) {
      throw new Error('Files restore target is not the ciphertext directory owned by the recovery journal; it was preserved');
    }
    await mkdir(dirname(stagedChunks), { recursive: true, mode: 0o700 });
    await rename(config.chunkRoot, stagedChunks);
    await rm(workspace, { recursive: true, force: true });
  }
  return false;
}

async function assertRecoverable(pool:import('pg').Pool):Promise<void> {
  const principals = await pool.query<{ count: number }>('SELECT count(DISTINCT owner_user_id)::int AS count FROM collections');
  if (principals.rows[0].count > 1) throw new Error('Backup requires every collection to belong to the same Vault principal');
  const unsupported = await pool.query(
    `SELECT k.collection_id FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      WHERE k.key_origin<>'random' OR c.compatibility_state<>'native' LIMIT 1`,
  );
  if (unsupported.rowCount) throw new Error('Backup requires every legacy collection to complete secure import first');
  const incomplete = await pool.query(
    `SELECT k.collection_id FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      LEFT JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id
       AND b.principal_id=c.owner_user_id AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
      WHERE b.collection_id IS NULL OR b.authority_registered_at IS NULL LIMIT 1`,
  );
  if (incomplete.rowCount) throw new Error('Backup requires a Vault-registered recovery bundle for every collection');
}

export async function backup(config:Config):Promise<string> {
  if (!config.backupTarget) throw new Error('SULLA_FILES_BACKUP_TARGET is required');
  const target = resolve(config.backupTarget);
  if (isWithin(config.chunkRoot, target)) throw new Error('Backup target must not be inside the Files chunk store');
  const chunkRoot = await lstat(config.chunkRoot);
  if (!chunkRoot.isDirectory() || chunkRoot.isSymbolicLink()) throw new Error('Files chunk store must be a real directory');
  await mkdir(target, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(tmpdir(), 'sulla-files-backup-'));
  try {
    const rowsPath = join(workspace, 'rows.jsonl');
    const snapshot = await createCoherentDatabaseSnapshot(config.databaseUrl, config.chunkRoot, join(workspace, 'chunks'), rowsPath);
    const validation = await restoreIsolatedDatabase(config.databaseUrl, rowsPath, snapshot.evidence);
    try { await assertRecoverable(validation.pool) } finally { await validation.cleanup() }

    const evidencePath = join(workspace, 'schema-evidence.json');
    await writeFile(evidencePath, JSON.stringify(snapshot.evidence), { mode: 0o600 });
    const objects:BackupObject[] = [];
    objects.push({ path: 'database/rows.jsonl', type: 'postgres-rows', sourcePath: rowsPath, ...await sha256File(rowsPath) });
    objects.push({ path: 'schema/evidence.json', type: 'schema-evidence', sourcePath: evidencePath, ...await sha256File(evidencePath) });
    for (const chunk of snapshot.chunks) {
      const digest = await sha256File(chunk.backupPath);
      if (digest.size !== Number(chunk.stored_size)) throw new Error('Staged chunk size no longer matches database metadata');
      objects.push({ path: `chunks/${ chunk.collection_id }/${ chunk.id.slice(0, 2) }/${ chunk.id }`, type: 'encrypted-chunk', sourcePath: chunk.backupPath, ...digest });
    }
    const manifest:BackupManifest = {
      format:            'sulla-files-coherent-backup',
      version:           1,
      createdAt:         new Date().toISOString(),
      postgresVersion:   snapshot.evidence.postgresVersion,
      snapshotId:        snapshot.snapshotId,
      migrations:        snapshot.evidence.migrations,
      tables:            snapshot.evidence.tables,
      excludedTableData: Object.fromEntries(Object.entries(EPHEMERAL_TABLE_DATA).filter(([name]) => snapshot.evidence.tables.some(table => table.name === name))),
      entries:           objects.map(({ sourcePath: _sourcePath, ...entry }) => entry),
    };
    const destination = join(target, `sulla-files-${ manifest.createdAt.replace(/[:.]/g, '-') }${ EXTENSION }`);
    await writeContainer(destination, manifest, objects);
    console.log(`[SullaFiles] coherent backup created ${ destination }`);
    return destination;
  } finally { await rm(workspace, { recursive: true, force: true }) }
}

async function selectedArchive(config:Config, archive?:string):Promise<string> {
  if (archive) return resolve(archive);
  if (!config.backupTarget) throw new Error('SULLA_FILES_BACKUP_TARGET or an archive path is required');
  const candidates = (await readdir(config.backupTarget)).filter(name => name.endsWith(EXTENSION)).sort();
  if (!candidates.length) throw new Error('No coherent Files backup found');
  return join(config.backupTarget, candidates.at(-1)!);
}

async function validateStagedInventory(pool:import('pg').Pool, schema:SchemaEvidence, manifest:BackupManifest):Promise<void> {
  await assertRecoverable(pool);
  const missing = await pool.query(
    `SELECT v.id FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
     CROSS JOIN LATERAL jsonb_array_elements_text(m.chunk_ids) item(chunk_id)
     LEFT JOIN chunks c ON c.collection_id=v.chunk_collection_id AND c.id=item.chunk_id
     WHERE c.id IS NULL LIMIT 1`,
  );
  if (missing.rowCount) throw new Error('Restored metadata has an unresolved chunk reference');
  const chunkRows = (await pool.query<{ collection_id: string; id: string; stored_size: number }>(
    'SELECT collection_id::text,id,stored_size FROM chunks ORDER BY collection_id,id',
  )).rows;
  const archived = new Map(manifest.entries.filter(entry => entry.type === 'encrypted-chunk').map(entry => [entry.path, entry]));
  if (archived.size !== chunkRows.length) throw new Error('Backup chunk inventory does not match restored PostgreSQL metadata');
  for (const chunk of chunkRows) {
    const path = `chunks/${ chunk.collection_id }/${ chunk.id.slice(0, 2) }/${ chunk.id }`;
    const entry = archived.get(path);
    if (entry?.size !== Number(chunk.stored_size)) throw new Error(`Backup chunk metadata mismatch: ${ path }`);
  }
  if (JSON.stringify(schema.tables.map(table => table.name)) !== JSON.stringify((manifest.tables as SchemaEvidence['tables']).map(table => table.name))) {
    throw new Error('Backup schema evidence does not match its manifest');
  }
}

async function restoreLocked(config:Config, archive?:string):Promise<string> {
  const selected = await selectedArchive(config, archive);
  await mkdir(dirname(config.chunkRoot), { recursive: true, mode: 0o700 });
  const archiveDigest = await sha256File(selected);
  let publication:PublicationIdentity | undefined;
  // A prior process may have died after publishing ciphertext or while COMMIT's
  // result was ambiguous. Reconcile its durable marker before creating a new stage.
  const recovered = await recoverInterruptedPublications(config, archiveDigest.sha256);
  if (recovered) return selected;
  // The validated ciphertext stage must share a filesystem with chunkRoot so
  // publication and rollback use atomic rename even when /tmp is another volume.
  const workspace = await mkdtemp(join(dirname(config.chunkRoot), RESTORE_WORKSPACE_PREFIX));
  let extracted:Awaited<ReturnType<typeof validateAndExtractContainer>> | undefined;
  let database:Awaited<ReturnType<typeof restoreIsolatedDatabase>> | undefined;
  let preserveWorkspace = false;
  try {
    extracted = await validateAndExtractContainer(selected, join(workspace, 'validated'));
    const evidence = JSON.parse(await readFile(extracted.path('schema/evidence.json'), 'utf8')) as SchemaEvidence;
    if (JSON.stringify(evidence.tables) !== JSON.stringify(extracted.manifest.tables) ||
        JSON.stringify(evidence.migrations) !== JSON.stringify(extracted.manifest.migrations) ||
        evidence.postgresVersion !== extracted.manifest.postgresVersion) throw new Error('Backup schema evidence is inconsistent');
    database = await restoreIsolatedDatabase(config.databaseUrl, extracted.path('database/rows.jsonl'), evidence);
    await validateStagedInventory(database.pool, evidence, extracted.manifest);
    await mkdir(extracted.path('chunks'), { recursive: true, mode: 0o700 });
    publication = { snapshotId: extracted.manifest.snapshotId, archiveSha256: archiveDigest.sha256 };
    const baseState = {
      version:          1 as const,
      publicationToken: randomUUID(),
      stagedIdentity:   await directoryIdentity(extracted.path('chunks')),
      ...publication,
    };
    await writeRestoreState(workspace, { ...baseState, phase: 'validated' });
    await publishDatabase(config.databaseUrl, extracted.path('database/rows.jsonl'), evidence, publication, async() => {
      if (!(await directoryIsEmpty(config.chunkRoot))) throw new Error('Files restore target contains data; existing content was preserved');
      const targetBefore = await exists(config.chunkRoot) ? await directoryIdentity(config.chunkRoot) : null;
      await writeRestoreState(workspace, { ...baseState, phase: 'publishing', targetBefore });
      try { await rmdir(config.chunkRoot) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
      await rename(extracted!.path('chunks'), config.chunkRoot);
      if (!sameIdentity(await directoryIdentity(config.chunkRoot), baseState.stagedIdentity)) throw new Error('Published ciphertext directory identity changed unexpectedly');
      try { await writeRestoreState(workspace, { ...baseState, phase: 'chunks-published', targetBefore }) } catch (error) { await rename(config.chunkRoot, extracted!.path('chunks')); throw error }
      return () => rename(config.chunkRoot, extracted!.path('chunks'));
    });
    console.log(`[SullaFiles] coherent backup restored from ${ selected }; complete fresh-device key recovery through Vault before starting Files`);
    return selected;
  } catch (error) {
    preserveWorkspace = error instanceof PublicationOutcomeUnknownError;
    throw error;
  } finally {
    await database?.cleanup().catch(() => undefined);
    if (!preserveWorkspace) {
      await extracted?.cleanup().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function restore(config:Config, archive?:string):Promise<string> {
  await mkdir(dirname(config.chunkRoot), { recursive: true, mode: 0o700 });
  const lock = await acquireRestoreLock(config.databaseUrl, config.chunkRoot);
  try { return await restoreLocked(config, archive) } finally { await lock.release() }
}

export async function nightlyBackups(config:Config):Promise<never> {
  for (;;) {
    const now = new Date(); const next = new Date(now); next.setHours(2, 0, 0, 0); if (next <= now) next.setDate(next.getDate() + 1);
    await new Promise(resolve => setTimeout(resolve, next.getTime() - now.getTime())); await backup(config);
  }
}
