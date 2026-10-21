import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
const MIGRATION_APPLICATION = 'sulla-files-migrate';
const MIGRATION_LOCK = 8_795_043;
const MIGRATION_RETRIES = 3;
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
export async function connect(url:string, max = 10) {
  const db = new pg.Pool({ connectionString: url, max });
  // An idle client dropped by Postgres (restart, admin terminate) is replaced on next use; unhandled, it kills the service.
  db.on('error', error => console.error('[SullaFiles] idle database connection lost:', error.message));
  await db.query('SELECT 1'); return db
}
export async function connectOptional(url?:string) { if (!url) return undefined; return connect(url) }
function retryableMigrationError(error:unknown):boolean {
  return typeof error === 'object' && error !== null && ['55P03', '40P01', '40001'].includes(String((error as { code?:string }).code));
}
export async function migrate(db:pg.Pool) {
  const here = dirname(fileURLToPath(import.meta.url)); const dir = resolve(here, '../migrations');
  const files = (await readdir(dir)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const c = await db.connect();
  try {
    // Use an unnamed connection until the lock is held: concurrent live
    // starters then wait instead of terminating each other.
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name=$1 AND pid<>pg_backend_pid()`, [MIGRATION_APPLICATION]);
    await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name=$1 AND pid<>pg_backend_pid()`, [MIGRATION_APPLICATION]);
    await c.query("SELECT set_config('application_name',$1,false)", [MIGRATION_APPLICATION]);
    await c.query('CREATE TABLE IF NOT EXISTS files_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    for (const file of files) {
      if ((await c.query('SELECT 1 FROM files_schema_migrations WHERE version=$1', [file])).rowCount) continue;
      const sql = await readFile(resolve(dir, file), 'utf8');
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        console.log(`[SullaFiles] migration ${ file } starting (attempt ${ attempt }/${ MIGRATION_RETRIES })`);
        try {
          await c.query('BEGIN'); await c.query(sql);
          await c.query('INSERT INTO files_schema_migrations(version) VALUES($1)', [file]); await c.query('COMMIT');
          console.log(`[SullaFiles] migration ${ file } completed in ${ Date.now() - started }ms`); break;
        } catch (error) {
          await c.query('ROLLBACK').catch(() => undefined);
          if (!retryableMigrationError(error) || attempt >= MIGRATION_RETRIES) throw error;
          const delay = attempt * 1_000;
          console.warn(`[SullaFiles] migration ${ file } lock contention after ${ Date.now() - started }ms; retrying in ${ delay }ms`);
          await sleep(delay);
        }
      }
    }
  // A database first started on the stock image records the optional migration without pgvector.
  // Retry it after an image upgrade; it is idempotent and returns immediately once the table exists.
    const vectorReady = await c.query("SELECT to_regclass('file_search_vectors') IS NOT NULL ready, EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') available");
    if (!vectorReady.rows[0].ready && vectorReady.rows[0].available) await c.query(await readFile(resolve(dir, '045_pgvector_search.sql'), 'utf8'));
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined); c.release();
  }
}
