// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

/**
 * Startup repair of the indexing bookkeeping: derived rows of deleted, protected, superseded
 * or unindexed-area files are removed, interrupted work is re-queued, invalid outcomes are
 * marked failed, missing reasons are filled and every indexable current version gets exactly
 * one job row. Run it inside one transaction (it takes a transaction-scoped advisory lock).
 */
export class IndexingAccountingRepository {
  constructor(private readonly db:SearchQueryable) {}

  on(client:SearchQueryable):IndexingAccountingRepository { return new IndexingAccountingRepository(client) }

  async reconcile(excluded:string[]):Promise<void> {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext('sulla-files:indexing-accounting'))");
    await this.db.query(`DELETE FROM file_search_text st USING files f,collections c
    WHERE st.file_id=f.id AND c.id=f.collection_id
      AND (f.deleted_at IS NOT NULL OR c.system_area=ANY($1::text[])
        OR EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id))`, [excluded]);
    await this.db.query(`DELETE FROM file_search_chunks ch USING files f,collections c
    WHERE ch.file_id=f.id AND c.id=f.collection_id
      AND (f.deleted_at IS NOT NULL OR f.current_version_id IS DISTINCT FROM ch.version_id
        OR c.system_area=ANY($1::text[]) OR EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id))`, [excluded]);
    await this.db.query(`DELETE FROM file_index_jobs j USING files f,collections c
    WHERE j.file_id=f.id AND c.id=f.collection_id
      AND (f.deleted_at IS NOT NULL OR f.current_version_id IS DISTINCT FROM j.version_id
        OR c.system_area=ANY($1::text[]) OR EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id))`, [excluded]);
    await this.db.query(`UPDATE file_index_jobs j SET status='pending',reason_code='interrupted',reason='Indexing was interrupted and will retry.',available_at=NOW()
    FROM files f,collections c WHERE j.file_id=f.id AND c.id=f.collection_id AND j.status='indexing'
      AND NOT coalesce(c.system_area=ANY($1::text[]),FALSE) AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`, [excluded]);
    await this.db.query(`UPDATE files f SET extraction_status='pending',extracted_at=NULL,extraction_reason_code='interrupted',extraction_reason='Indexing was interrupted and will retry.'
    FROM collections c WHERE c.id=f.collection_id AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL AND f.extraction_status='indexing'
      AND NOT coalesce(c.system_area=ANY($1::text[]),FALSE) AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`, [excluded]);
    await this.db.query(`UPDATE files f SET extraction_status='failed',extracted_at=NOW(),extraction_reason_code='accounting_repaired',extraction_reason='The prior indexing outcome was invalid. Re-index this file.'
    FROM collections c WHERE c.id=f.collection_id AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL
      AND f.extraction_status NOT IN('pending','indexed','failed','unsupported')
      AND NOT coalesce(c.system_area=ANY($1::text[]),FALSE) AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`, [excluded]);
    await this.db.query(`UPDATE files f SET
      extraction_reason_code=coalesce(nullif(f.extraction_reason_code,''),CASE f.extraction_status WHEN 'pending' THEN 'queue_repaired' WHEN 'indexed' THEN 'indexed_outcome_repaired' WHEN 'unsupported' THEN 'unsupported_outcome_repaired' ELSE 'failed_outcome_repaired' END),
      extraction_reason=coalesce(nullif(f.extraction_reason,''),CASE f.extraction_status WHEN 'pending' THEN 'Waiting for local indexing.' WHEN 'indexed' THEN 'Indexed locally.' WHEN 'unsupported' THEN 'This file type is not supported by the local indexer.' ELSE 'Local indexing failed. Re-index to try again.' END)
    FROM collections c WHERE c.id=f.collection_id AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL
      AND NOT coalesce(c.system_area=ANY($1::text[]),FALSE) AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`, [excluded]);
    await this.db.query(`INSERT INTO file_index_jobs(file_id,version_id,status,reason_code,reason,finished_at)
    SELECT f.id,f.current_version_id,f.extraction_status,f.extraction_reason_code,f.extraction_reason,
      CASE WHEN f.extraction_status IN('indexed','failed','unsupported') THEN coalesce(f.extracted_at,NOW()) END
    FROM files f JOIN collections c ON c.id=f.collection_id
    WHERE f.deleted_at IS NULL AND f.current_version_id IS NOT NULL
      AND f.extraction_status IN('pending','indexed','failed','unsupported')
      AND NOT coalesce(c.system_area=ANY($1::text[]),FALSE) AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
    ON CONFLICT(version_id) DO UPDATE SET
      file_id=EXCLUDED.file_id,status=EXCLUDED.status,reason_code=EXCLUDED.reason_code,reason=EXCLUDED.reason,
      attempts=CASE WHEN EXCLUDED.status='pending' THEN 0 ELSE file_index_jobs.attempts END,
      last_error=NULL,available_at=CASE WHEN EXCLUDED.status='pending' THEN NOW() ELSE file_index_jobs.available_at END,
      started_at=NULL,finished_at=EXCLUDED.finished_at`, [excluded]);
  }
}
