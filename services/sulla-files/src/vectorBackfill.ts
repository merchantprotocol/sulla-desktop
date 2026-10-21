import type pg from 'pg';
import { VECTOR_READY_MARKER } from './vectorState.js';

const COPY_BATCH = 1_000;
const NULL_BATCH = 2_000;
const PAUSE_MS = 50;
const START_DELAY_MS = 30_000;
const LOCK_KEY = 4_511_045; // pg_try_advisory_lock key: one backfill at a time
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref?.());

/**
 * Moves JSON embeddings into the halfvec table, builds the HNSW index, flips the
 * "ready" marker (search switches to halfvec) and finally drops the JSON copies.
 * Throttled and idempotent; safe to run on every boot until the marker exists.
 * Never throws: failures are logged and the next boot resumes.
 */
export async function runVectorBackfill(db: pg.Pool, log: (message: string) => void = console.log): Promise<void> {
  const lock = await db.connect();
  try {
    if (!(await lock.query('SELECT pg_try_advisory_lock($1) ok', [LOCK_KEY])).rows[0].ok) return;
    const status = (await lock.query(`SELECT to_regclass('file_search_vectors') IS NOT NULL has_table,
      EXISTS(SELECT 1 FROM files_schema_migrations WHERE version=$1) done`, [VECTOR_READY_MARKER])).rows[0];
    if (!status.has_table) return;

    if (!status.done) {
      let copied = 0;
      for (;;) {
        const result = await db.query(`WITH batch AS (
            SELECT sc.id, sc.embedding_json::text AS embedding FROM file_search_chunks sc
            WHERE sc.embedding_json IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM file_search_vectors sv WHERE sv.chunk_id=sc.id)
            LIMIT ${ COPY_BATCH })
          INSERT INTO file_search_vectors(chunk_id,embedding) SELECT id, embedding::halfvec(512) FROM batch ON CONFLICT DO NOTHING`);
        if (!result.rowCount) break;
        copied += result.rowCount;
        if (copied % 20_000 < COPY_BATCH) log(`[FilesVector] copied ${ copied } embeddings`);
        await sleep(PAUSE_MS);
      }
      log(`[FilesVector] copy complete (${ copied } rows); building HNSW index`);
      const builder = await db.connect();
      try {
        // A failed CONCURRENTLY build leaves an INVALID index behind; rebuild it.
        await builder.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='idx_file_search_vectors_hnsw' AND NOT i.indisvalid) THEN
            DROP INDEX idx_file_search_vectors_hnsw; END IF; END $$`);
        // Parallel builds need POSIX shared memory; the managed container has Docker's default 64MB /dev/shm.
        await builder.query('SET max_parallel_maintenance_workers = 0');
        await builder.query('SET maintenance_work_mem = \'256MB\'');
        await builder.query('SET statement_timeout = 0');
        await builder.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_file_search_vectors_hnsw
          ON file_search_vectors USING hnsw (embedding halfvec_cosine_ops) WITH (m=16, ef_construction=64)`);
      } finally { builder.release(true) }
      // Rows indexed while the build ran carry both copies; anything still JSON-only gets one more pass.
      const leftover = await db.query(`SELECT 1 FROM file_search_chunks sc WHERE sc.embedding_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM file_search_vectors sv WHERE sv.chunk_id=sc.id) LIMIT 1`);
      if (leftover.rowCount) { log('[FilesVector] new rows appeared during the index build; will finish on the next start'); return; }
      await db.query('INSERT INTO files_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [VECTOR_READY_MARKER]);
      log('[FilesVector] semantic search now uses halfvec + HNSW');
    }

    let cleared = 0;
    for (;;) {
      const result = await db.query(`UPDATE file_search_chunks sc SET embedding_json=NULL
        WHERE sc.id IN (SELECT c.id FROM file_search_chunks c JOIN file_search_vectors v ON v.chunk_id=c.id
          WHERE c.embedding_json IS NOT NULL LIMIT ${ NULL_BATCH })`);
      if (!result.rowCount) break;
      cleared += result.rowCount;
      await sleep(PAUSE_MS);
    }
    if (cleared) log(`[FilesVector] dropped ${ cleared } JSON embedding copies`);
  } catch (error) {
    log(`[FilesVector] backfill paused: ${ error instanceof Error ? error.message : String(error) }`);
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lock.release();
  }
}

/** Starts the backfill shortly after startup; never awaited by the caller. */
export function startVectorBackfill(db: pg.Pool): void {
  setTimeout(() => { void runVectorBackfill(db) }, START_DELAY_MS).unref?.();
}
