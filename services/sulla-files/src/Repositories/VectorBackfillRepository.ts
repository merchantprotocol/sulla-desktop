// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

/**
 * The halfvec backfill's statements. Bind it to ONE dedicated session (`db.connect()`):
 * the advisory lock is session-scoped and the maintenance SETs must stay on that session,
 * which the caller then destroys instead of returning it to the pool.
 */
export class VectorBackfillRepository {
  constructor(private readonly session:SearchQueryable) {}

  async tryLock(key:number):Promise<boolean> {
    return Boolean((await this.session.query('SELECT pg_try_advisory_lock($1) ok', [key])).rows[0].ok);
  }

  async unlock(key:number):Promise<void> {
    await this.session.query('SELECT pg_advisory_unlock($1)', [key]);
  }

  async status(marker:string):Promise<{ has_table:boolean; done:boolean }> {
    return (await this.session.query(`SELECT to_regclass('file_search_vectors') IS NOT NULL has_table,
      EXISTS(SELECT 1 FROM files_schema_migrations WHERE version=$1) done`, [marker])).rows[0];
  }

  /** Copies up to `batch` JSON-only embeddings into halfvec rows; returns how many were copied. */
  async copyBatch(batch:number):Promise<number> {
    const result = await this.session.query(`WITH batch AS (
            SELECT sc.id, sc.embedding_json::text AS embedding FROM file_search_chunks sc
            WHERE sc.embedding_json IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM file_search_vectors sv WHERE sv.chunk_id=sc.id)
            LIMIT ${ Math.trunc(batch) })
          INSERT INTO file_search_vectors(chunk_id,embedding) SELECT id, embedding::halfvec(512) FROM batch ON CONFLICT DO NOTHING`);
    return result.rowCount ?? 0;
  }

  /** Builds the HNSW index, first dropping an INVALID one a failed CONCURRENTLY build left behind. */
  async buildIndex():Promise<void> {
    await this.session.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='idx_file_search_vectors_hnsw' AND NOT i.indisvalid) THEN
            DROP INDEX idx_file_search_vectors_hnsw; END IF; END $$`);
    // Parallel builds need POSIX shared memory; the managed container has Docker's default 64MB /dev/shm.
    await this.session.query('SET max_parallel_maintenance_workers = 0');
    await this.session.query('SET maintenance_work_mem = \'256MB\'');
    await this.session.query('SET statement_timeout = 0');
    await this.session.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_file_search_vectors_hnsw
          ON file_search_vectors USING hnsw (embedding halfvec_cosine_ops) WITH (m=16, ef_construction=64)`);
  }

  /** Any chunk that still has only its JSON embedding. */
  async hasJsonOnlyChunks():Promise<boolean> {
    const leftover = await this.session.query(`SELECT 1 FROM file_search_chunks sc WHERE sc.embedding_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM file_search_vectors sv WHERE sv.chunk_id=sc.id) LIMIT 1`);
    return Boolean(leftover.rowCount);
  }

  async markReady(marker:string):Promise<void> {
    await this.session.query('INSERT INTO files_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [marker]);
  }

  /** Drops up to `batch` JSON copies whose halfvec row exists; returns how many were cleared. */
  async clearJsonBatch(batch:number):Promise<number> {
    const result = await this.session.query(`UPDATE file_search_chunks sc SET embedding_json=NULL
        WHERE sc.id IN (SELECT c.id FROM file_search_chunks c JOIN file_search_vectors v ON v.chunk_id=c.id
          WHERE c.embedding_json IS NOT NULL LIMIT ${ Math.trunc(batch) })`);
    return result.rowCount ?? 0;
  }
}
