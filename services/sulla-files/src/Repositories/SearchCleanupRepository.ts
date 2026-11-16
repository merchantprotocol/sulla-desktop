// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

/**
 * Deletes obsolete derived search rows in small batches: rows of the `logs` system area,
 * and chunks/jobs of versions that are no longer the file's current version. Bind it to
 * one dedicated session; the advisory lock is session-scoped.
 */
export class SearchCleanupRepository {
  constructor(private readonly session:SearchQueryable) {}

  async tryLock(key:number):Promise<boolean> {
    return Boolean((await this.session.query('SELECT pg_try_advisory_lock($1) ok', [key])).rows[0].ok);
  }

  async unlock(key:number):Promise<void> {
    await this.session.query('SELECT pg_advisory_unlock($1)', [key]);
  }

  /** Each returns how many rows the batch removed. */
  async deleteObsoleteChunks(batch:number):Promise<number> {
    return (await this.session.query(`DELETE FROM file_search_chunks sc USING (SELECT sc2.id FROM file_search_chunks sc2 JOIN files f ON f.id=sc2.file_id JOIN collections c ON c.id=f.collection_id WHERE c.system_area = 'logs' OR sc2.version_id IS DISTINCT FROM f.current_version_id LIMIT ${ Math.trunc(batch) }) batch WHERE sc.id=batch.id`)).rowCount ?? 0;
  }

  async deleteLogsSearchText(batch:number):Promise<number> {
    return (await this.session.query(`DELETE FROM file_search_text st USING (SELECT st2.file_id FROM file_search_text st2 JOIN files f ON f.id=st2.file_id JOIN collections c ON c.id=f.collection_id WHERE c.system_area = 'logs' LIMIT ${ Math.trunc(batch) }) batch WHERE st.file_id=batch.file_id`)).rowCount ?? 0;
  }

  async deleteObsoleteJobs(batch:number):Promise<number> {
    return (await this.session.query(`DELETE FROM file_index_jobs j USING (SELECT j2.version_id FROM file_index_jobs j2 JOIN files f ON f.id=j2.file_id JOIN collections c ON c.id=f.collection_id WHERE c.system_area = 'logs' OR j2.version_id IS DISTINCT FROM f.current_version_id LIMIT ${ Math.trunc(batch) }) batch WHERE j.version_id=batch.version_id`)).rowCount ?? 0;
  }
}
