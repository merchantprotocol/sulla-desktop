import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const ROW_BATCH = 256;
const MAX_ROW_BYTES = 16 * 1024 * 1024;
export const EPHEMERAL_TABLE_DATA:Record<string, string> = {
  file_upload_intents:        'Incomplete unpublished uploads are not Files state; only chunks committed to the chunks table are included.',
  files_restore_publications: 'Restore publication markers are local crash-recovery state and are regenerated when a snapshot is published.',
  generated_previews:         'Generated thumbnails are a disposable cache and are regenerated from authenticated file content.',
};

export interface ColumnEvidence { name: string; type: string; nullable: boolean; default: string | null; generated: string }
export interface ConstraintEvidence { name: string; type: string; definition: string }
export interface TableEvidence { name: string; rows: string; columns: ColumnEvidence[]; constraints: ConstraintEvidence[] }
export interface SchemaEvidence {
  migrations:      string[];
  migrationHashes: Record<string, string>;
  tables:          TableEvidence[];
  extensions:      string[];
  postgresVersion: string;
}
export interface ChunkRow { collection_id: string; id: string; size: number; stored_size: number; location: string; refcount: string; backupPath: string }

function identifier(value:string):string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${ value }`);
  return `"${ value }"`;
}

async function writeAll(handle:Awaited<ReturnType<typeof open>>, value:Buffer, position:number):Promise<void> {
  let written = 0;
  while (written < value.length) {
    const result = await handle.write(value, written, value.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Backup destination stopped accepting bytes');
    written += result.bytesWritten;
  }
}

function tablesCreatedBy(sql:string):string[] {
  const names = new Set<string>();
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z][a-z0-9_]*)["']?/gi;
  for (const match of sql.matchAll(pattern)) names.add(match[1]);
  return [...names];
}

function extensionsCreatedBy(sql:string):string[] {
  const names = new Set<string>();
  const pattern = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z][a-z0-9_]*)"?/gi;
  for (const match of sql.matchAll(pattern)) names.add(match[1]);
  return [...names];
}

interface InstalledMigration { sql: string; hash: string; tables: string[]; extensions: string[] }

async function installedMigrations():Promise<Map<string, InstalledMigration>> {
  const installed = new Map<string, InstalledMigration>();
  for (const name of (await readdir(MIGRATIONS)).filter(value => /^\d+_[a-z0-9_]+\.sql$/.test(value))) {
    const sql = await readFile(resolve(MIGRATIONS, name), 'utf8');
    installed.set(name, {
      sql,
      hash:       createHash('sha256').update(sql).digest('hex'),
      tables:     tablesCreatedBy(sql),
      extensions: extensionsCreatedBy(sql),
    });
  }
  return installed;
}

async function ownedTables(client:pg.PoolClient):Promise<{ migrations: string[]; migrationHashes: Record<string, string>; tables: string[]; extensions: string[] }> {
  const applied = (await client.query<{ version: string }>('SELECT version FROM files_schema_migrations ORDER BY version')).rows.map(row => row.version);
  const installed = await installedMigrations();
  const tables = new Set<string>(['files_schema_migrations']); const extensions = new Set<string>(); const migrationHashes:Record<string, string> = {};
  for (const migration of applied) {
    const source = installed.get(migration);
    if (!source) throw new Error(`Applied Files migration source is unavailable: ${ migration }`);
    migrationHashes[migration] = source.hash;
    for (const table of source.tables) tables.add(table);
    for (const extension of source.extensions) extensions.add(extension);
  }
  const existing = (await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name=ANY($1) ORDER BY table_name`, [[...tables]],
  )).rows.map(row => row.table_name);
  if (!['collections', 'chunks', 'file_versions', 'files_collection_key_bundles'].every(name => existing.includes(name))) {
    throw new Error('Files schema is incomplete; migrate and recovery-enroll it before backup');
  }
  return { migrations: applied, migrationHashes, tables: existing, extensions: [...extensions].sort() };
}

async function evidence(client:pg.PoolClient, migrations:string[], migrationHashes:Record<string, string>, tables:string[], ownedExtensions:string[]):Promise<SchemaEvidence> {
  const result:TableEvidence[] = [];
  for (const table of tables) {
    const columns = (await client.query(
      `SELECT column_name AS name,udt_schema||'.'||udt_name AS type,is_nullable='YES' AS nullable,column_default AS default,is_generated AS generated
         FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table],
    )).rows as ColumnEvidence[];
    const constraints = (await client.query(
      `SELECT c.conname AS name,c.contype AS type,pg_get_constraintdef(c.oid,true) AS definition
         FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public' AND r.relname=$1 ORDER BY c.conname`, [table],
    )).rows as ConstraintEvidence[];
    const rows = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${ identifier(table) }`)).rows[0].count;
    result.push({ name: table, rows, columns, constraints });
  }
  const extensions = ownedExtensions.length
    ? (await client.query<{ extname: string }>('SELECT extname FROM pg_extension WHERE extname=ANY($1) ORDER BY extname', [ownedExtensions])).rows.map(row => row.extname)
    : [];
  const postgresVersion = (await client.query<{ version: string }>("SELECT current_setting('server_version') AS version")).rows[0].version;
  return { migrations, migrationHashes, tables: result, extensions, postgresVersion };
}

function sameSchema(actual:SchemaEvidence, expected:SchemaEvidence):boolean {
  return JSON.stringify({ migrations: actual.migrations, migrationHashes: actual.migrationHashes, tables: actual.tables.map(({ rows:_rows, ...table }) => table), extensions: actual.extensions }) ===
    JSON.stringify({ migrations: expected.migrations, migrationHashes: expected.migrationHashes, tables: expected.tables.map(({ rows:_rows, ...table }) => table), extensions: expected.extensions });
}

async function writeRows(client:pg.PoolClient, destination:string, tables:string[]):Promise<void> {
  const output = await open(destination, 'wx', 0o600);
  let position = 0;
  try {
    for (const table of tables.filter(name => name !== 'files_schema_migrations' && !(name in EPHEMERAL_TABLE_DATA))) {
      await client.query(`DECLARE files_backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(value)::text AS row_json FROM public.${ identifier(table) } value`);
      try {
        for (;;) {
          const rows = (await client.query<{ row_json: string }>(`FETCH FORWARD ${ ROW_BATCH } FROM files_backup_rows`)).rows;
          if (!rows.length) break;
          for (const row of rows) {
            const value = Buffer.from(`${ table }\t${ row.row_json }\n`);
            if (value.length - 1 > MAX_ROW_BYTES) throw new Error('Files database row exceeds the backup format size limit');
            await writeAll(output, value, position); position += value.length;
          }
        }
      } finally { await client.query('CLOSE files_backup_rows') }
    }
    await output.sync();
  } finally { await output.close() }
}

async function copyChunk(sourcePath:string, destination:string, expectedBytes:number):Promise<void> {
  for (const ancestor of [dirname(dirname(sourcePath)), dirname(sourcePath)]) {
    const info = await lstat(ancestor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Chunk store contains an unsafe path type');
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW); const output = await open(destination, 'wx', 0o600);
  let offset = 0;
  try {
    const before = await source.stat(); if (!before.isFile() || before.size !== expectedBytes) throw new Error('Chunk ciphertext does not match its database inventory');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (offset < expectedBytes) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
      if (!bytesRead) throw new Error('Chunk ciphertext was truncated during backup');
      await writeAll(output, buffer.subarray(0, bytesRead), offset); offset += bytesRead;
    }
    const after = await source.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Chunk ciphertext changed during backup');
    await output.sync();
  } finally { await Promise.allSettled([source.close(), output.close()]) }
}

export interface CoherentSnapshot { snapshotId: string; evidence: SchemaEvidence; chunks: ChunkRow[]; rowsPath: string }

export async function createCoherentDatabaseSnapshot(databaseUrl:string, chunkRoot:string, chunkStageRoot:string, rowsPath:string):Promise<CoherentSnapshot> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 }); const client = await pool.connect();
  try {
    // Discover candidates outside the repeatable-read transaction. The
    // authoritative inventory is re-read only after all candidate tables are locked.
    const candidates = await ownedTables(client);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`LOCK TABLE ${ candidates.tables.map(name => `public.${ identifier(name) }`).join(',') } IN SHARE MODE`);
    const owned = await ownedTables(client);
    if (JSON.stringify(owned) !== JSON.stringify(candidates)) throw new Error('Files schema changed while backup locks were acquired');
    const snapshotId = (await client.query<{ id: string }>('SELECT txid_current_snapshot()::text AS id')).rows[0].id;
    const schema = await evidence(client, owned.migrations, owned.migrationHashes, owned.tables, owned.extensions);
    for (const table of schema.tables) if (table.name in EPHEMERAL_TABLE_DATA) table.rows = '0';
    const missing = await client.query(
      `SELECT v.id FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
       CROSS JOIN LATERAL jsonb_array_elements_text(m.chunk_ids) item(chunk_id)
       LEFT JOIN chunks c ON c.collection_id=v.chunk_collection_id AND c.id=item.chunk_id WHERE c.id IS NULL LIMIT 1`,
    );
    if (missing.rowCount) throw new Error('Files metadata references a chunk absent from its inventory');
    const chunks = (await client.query<Omit<ChunkRow, 'backupPath'>>(
      'SELECT collection_id::text,id,size,stored_size,location,refcount::text FROM chunks ORDER BY collection_id,id',
    )).rows.map(row => ({ ...row, backupPath: join(chunkStageRoot, row.collection_id, row.id.slice(0, 2), row.id) }));
    await writeRows(client, rowsPath, owned.tables);
    for (const chunk of chunks) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(chunk.collection_id) || !/^[a-f0-9]{64}$/.test(chunk.id) ||
          chunk.location !== `chunks/${ chunk.collection_id }/${ chunk.id }` || !Number.isSafeInteger(Number(chunk.stored_size))) {
        throw new Error('Chunk database inventory contains an unsafe or unsupported record');
      }
      await copyChunk(join(chunkRoot, chunk.collection_id, chunk.id.slice(0, 2), chunk.id), chunk.backupPath, Number(chunk.stored_size));
    }
    await client.query('COMMIT'); return { snapshotId, evidence: schema, chunks, rowsPath };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release(); await pool.end() }
}

function databaseUrlFor(source:string, database:string):string { const url = new URL(source); url.pathname = `/${ encodeURIComponent(database) }`; return url.toString() }
export interface StagedDatabase { database: string; url: string; pool: pg.Pool; cleanup():Promise<void> }

export interface PublicationIdentity { snapshotId: string; archiveSha256: string }
export interface RestoreLock { release():Promise<void> }

export class PublicationOutcomeUnknownError extends Error {
  constructor(cause:unknown) { super('Files restore publication outcome is uncertain; preserved recovery state must be reconciled before retrying', { cause }) }
}

export async function acquireRestoreLock(databaseUrl:string, chunkRoot:string):Promise<RestoreLock> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 }); const client = await pool.connect();
  try { await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`sulla-files-restore:${ resolve(chunkRoot) }`]) } catch (error) { client.release(); await pool.end(); throw error }
  return {
    release: async() => {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`sulla-files-restore:${ resolve(chunkRoot) }`]) } finally { client.release(); await pool.end() }
    },
  };
}

async function assertRestorePrivileges(pool:pg.Pool):Promise<void> {
  const role = (await pool.query<{ rolcreatedb: boolean; rolsuper: boolean }>(
    'SELECT rolcreatedb,rolsuper FROM pg_roles WHERE rolname=current_user',
  )).rows[0];
  if (!role?.rolcreatedb) throw new Error('Files coherent restore requires the PostgreSQL service role to have CREATEDB for isolated validation');
  if (!role.rolsuper) throw new Error('Files coherent restore requires the PostgreSQL service role to be SUPERUSER for constraint-safe row loading');
}

async function applyInstalledSchema(pool:pg.Pool, expected:SchemaEvidence):Promise<void> {
  const installed = await installedMigrations();
  if (Object.keys(expected.migrationHashes).sort().join('\0') !== expected.migrations.slice().sort().join('\0')) throw new Error('Backup migration evidence is inconsistent');
  await pool.query('CREATE TABLE files_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const migration of expected.migrations) {
    const source = installed.get(migration);
    if (source?.hash !== expected.migrationHashes[migration]) throw new Error(`Installed Files migration does not match backup schema evidence: ${ migration }`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(source.sql); await client.query('INSERT INTO files_schema_migrations(version) VALUES($1)', [migration]); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}

async function loadRows(client:pg.PoolClient, rowsPath:string, expected:SchemaEvidence):Promise<void> {
  const tables = new Map(expected.tables.filter(table => table.name !== 'files_schema_migrations' && !(table.name in EPHEMERAL_TABLE_DATA)).map(table => [table.name, table]));
  await client.query("SET LOCAL session_replication_role='replica'");
  const insert = async(line:string) => {
    const separator = line.indexOf('\t'); if (separator < 1) throw new Error('Backup database row is malformed');
    const name = line.slice(0, separator); const table = tables.get(name); if (!table) throw new Error('Backup database row targets an unowned table');
    const json = line.slice(separator + 1); if (!json.startsWith('{') || !json.endsWith('}')) throw new Error('Backup database row is not an object');
    const columns = table.columns.filter(column => column.generated === 'NEVER').map(column => column.name);
    const list = columns.map(identifier).join(',');
    await client.query(`INSERT INTO public.${ identifier(name) }(${ list }) SELECT ${ list } FROM jsonb_populate_record(NULL::public.${ identifier(name) },$1::jsonb)`, [json]);
  };
  const input = (await import('node:fs')).createReadStream(rowsPath);
  let fragments:Buffer[] = []; let bytes = 0;
  const append = (value:Buffer) => {
    bytes += value.length;
    if (bytes > MAX_ROW_BYTES) throw new Error('Backup database row exceeds the safe size limit');
    if (value.length) fragments.push(value);
  };
  const flush = async() => {
    const line = Buffer.concat(fragments, bytes).toString('utf8'); fragments = []; bytes = 0;
    await insert(line);
  };
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) { append(chunk.subarray(offset)); break }
      append(chunk.subarray(offset, newline)); await flush(); offset = newline + 1;
    }
  }
  if (bytes || fragments.length) await flush();
  await client.query("SET LOCAL session_replication_role='origin'");
}

async function validateForeignKeys(client:pg.PoolClient, tableNames:string[]):Promise<void> {
  const constraints = (await client.query<{
    name: string; child_table: string; parent_table: string; child_columns: unknown; parent_columns: unknown; match_type: string;
  }>(`SELECT c.conname AS name,child.relname AS child_table,parent.relname AS parent_table,c.confmatchtype AS match_type,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS child_columns,
      ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS parent_columns
     FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
     JOIN pg_namespace n ON n.oid=child.relnamespace WHERE c.contype='f' AND n.nspname='public' AND child.relname=ANY($1)`, [tableNames])).rows;
  for (const constraint of constraints) {
    const array = (value:unknown):string[] => Array.isArray(value)
      ? value.map(String)
      : typeof value === 'string' && /^\{[a-z0-9_,]+\}$/.test(value) ? value.slice(1, -1).split(',') : [];
    const childColumns = array(constraint.child_columns); const parentColumns = array(constraint.parent_columns);
    if (!childColumns.length || childColumns.length !== parentColumns.length) throw new Error('Files foreign-key metadata is invalid');
    const nonnull = childColumns.map(column => `c.${ identifier(column) } IS NOT NULL`).join(' AND ');
    const any = childColumns.map(column => `c.${ identifier(column) } IS NOT NULL`).join(' OR ');
    const partial = childColumns.map(column => `c.${ identifier(column) } IS NULL`).join(' OR ');
    const match = childColumns.map((column, index) => `c.${ identifier(column) }=p.${ identifier(parentColumns[index]) }`).join(' AND ');
    const predicate = constraint.match_type === 'f'
      ? `((${ any }) AND ((${ partial }) OR NOT EXISTS(SELECT 1 FROM public.${ identifier(constraint.parent_table) } p WHERE ${ match })))`
      : `((${ nonnull }) AND NOT EXISTS(SELECT 1 FROM public.${ identifier(constraint.parent_table) } p WHERE ${ match }))`;
    if ((await client.query(`SELECT 1 FROM public.${ identifier(constraint.child_table) } c WHERE ${ predicate } LIMIT 1`)).rowCount) {
      throw new Error(`Backup violates foreign key ${ constraint.name }`);
    }
  }
}

async function resetSequences(client:pg.PoolClient, expected:SchemaEvidence):Promise<void> {
  for (const table of expected.tables) {
    for (const column of table.columns) {
      if (!column.default?.startsWith('nextval(')) continue;
      const sequence = (await client.query<{ sequence: string | null }>('SELECT pg_get_serial_sequence($1,$2) AS sequence', [`public.${ table.name }`, column.name])).rows[0].sequence;
      if (sequence) await client.query('SELECT setval($1::regclass,COALESCE((SELECT max(' + identifier(column.name) + ') FROM public.' + identifier(table.name) + '),1),EXISTS(SELECT 1 FROM public.' + identifier(table.name) + '))', [sequence]);
    }
  }
}

async function loadAndValidate(client:pg.PoolClient, rowsPath:string, expected:SchemaEvidence):Promise<void> {
  await loadRows(client, rowsPath, expected); await validateForeignKeys(client, expected.tables.map(table => table.name)); await resetSequences(client, expected);
}

function truncatableTables(expected:SchemaEvidence):string[] {
  return expected.tables.map(table => table.name).filter(name => name !== 'files_schema_migrations');
}

export async function restoreIsolatedDatabase(databaseUrl:string, rowsPath:string, expected:SchemaEvidence):Promise<StagedDatabase> {
  const stagingName = `sulla_files_restore_${ process.pid }_${ Date.now() }`; const adminUrl = databaseUrlFor(databaseUrl, 'postgres');
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await assertRestorePrivileges(admin);
  await admin.query(`CREATE DATABASE ${ identifier(stagingName) } TEMPLATE template0`);
  const stagingUrl = databaseUrlFor(databaseUrl, stagingName);
  const cleanup = async() => {
    await admin.query(`DROP DATABASE IF EXISTS ${ identifier(stagingName) }`).finally(() => admin.end());
  };
  let pool:pg.Pool | undefined;
  try {
    pool = new pg.Pool({ connectionString: stagingUrl, max: 2 }); await applyInstalledSchema(pool, expected);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE ${ truncatableTables(expected).map(name => `public.${ identifier(name) }`).join(',') }`);
      await loadAndValidate(client, rowsPath, expected); await client.query('COMMIT');
      const owned = await ownedTables(client);
      const actual = await evidence(client, owned.migrations, owned.migrationHashes, owned.tables, owned.extensions);
      if (!sameSchema(actual, expected) || JSON.stringify(actual.tables.map(table => table.rows)) !== JSON.stringify(expected.tables.map(table => table.rows))) {
        throw new Error('Restored database inventory does not match backup schema or row counts');
      }
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
    const stagedPool = pool;
    return { database: stagingName, url: stagingUrl, pool: stagedPool, cleanup: async() => { await stagedPool.end(); await cleanup() } };
  } catch (error) { await pool?.end().catch(() => undefined); await cleanup(); throw error }
}

export async function publishDatabase(
  databaseUrl:string,
  rowsPath:string,
  expected:SchemaEvidence,
  publication:PublicationIdentity,
  publishChunks:()=>Promise<()=>Promise<void>>,
):Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 }); const client = await pool.connect();
  let rollbackChunks:(()=>Promise<void>) | undefined;
  let commitAttempted = false;
  try {
    await client.query('BEGIN');
    await client.query(`LOCK TABLE ${ expected.tables.map(table => `public.${ identifier(table.name) }`).join(',') } IN ACCESS EXCLUSIVE MODE`);
    const target = await ownedTables(client); const actual = await evidence(client, target.migrations, target.migrationHashes, target.tables, target.extensions);
    if (!sameSchema(actual, expected)) throw new Error('Files restore target schema does not match the backup');
    for (const table of expected.tables.filter(table => table.name !== 'files_schema_migrations' && table.name !== 'files_runtime_state')) {
      if ((await client.query(`SELECT 1 FROM public.${ identifier(table.name) } LIMIT 1`)).rowCount) throw new Error('Files restore target is not empty');
    }
    rollbackChunks = await publishChunks();
    await client.query(`TRUNCATE ${ truncatableTables(expected).map(name => `public.${ identifier(name) }`).join(',') }`);
    await loadAndValidate(client, rowsPath, expected);
    await client.query('INSERT INTO files_restore_publications(snapshot_id,archive_sha256) VALUES($1,$2)', [publication.snapshotId, publication.archiveSha256]);
    commitAttempted = true;
    await client.query('COMMIT');
    rollbackChunks = undefined;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (commitAttempted) {
      try {
        if (await publicationCommitted(databaseUrl, publication)) { rollbackChunks = undefined; return }
      } catch (probeError) {
        throw new PublicationOutcomeUnknownError(new AggregateError([error, probeError], 'PostgreSQL commit failed and its durable publication marker could not be read'));
      }
    }
    if (rollbackChunks) {
      await rollbackChunks().catch(rollback => {
        throw new PublicationOutcomeUnknownError(new AggregateError([error, rollback], 'Files database and chunk rollback failed'));
      });
    }
    throw error;
  } finally { client.release(); await pool.end() }
}

export async function publicationCommitted(databaseUrl:string, publication:PublicationIdentity):Promise<boolean> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ archive_sha256: string }>(
      'SELECT archive_sha256 FROM files_restore_publications WHERE snapshot_id=$1', [publication.snapshotId],
    );
    if (!result.rowCount) return false;
    if (result.rows[0].archive_sha256 !== publication.archiveSha256) throw new Error('Restore publication marker conflicts with the selected archive');
    return true;
  } finally { await pool.end() }
}
