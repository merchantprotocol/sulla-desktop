// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/**
 * POST /v1/local/maintenance writes: retention disposal review and scratch TTL expiry.
 * Every method runs on the caller's transaction client.
 */
export class ScratchMaintenanceRepository {
  /** Trashed files whose retention has lapsed move to disposal review. Returns the affected ids. */
  async markPendingDisposals(client:pg.PoolClient):Promise<pg.QueryResult> {
    return client.query(`UPDATE files SET disposal_status='pending',disposal_review_at=NOW(),lifecycle_generation=lifecycle_generation+1
      WHERE deleted_at IS NOT NULL AND disposal_status='none' AND retention_mode<>'none' AND NOT files_retention_active(files) RETURNING id`);
  }

  /** Locks every live file whose scratch TTL has passed (reviewed unbounded read: maintenance-only sweep). */
  async lockExpired(client:pg.PoolClient, now:Date):Promise<any[]> {
    return (await client.query('SELECT * FROM files WHERE expires_at<$1 AND deleted_at IS NULL FOR UPDATE', [now])).rows;
  }

  /** Writes a deleted version over an expired file, trashes it and journals the delete. */
  async tombstone(client:pg.PoolClient, file:any, now:Date):Promise<void> {
    const deleted = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
        VALUES($1,$2,$3,NULL,0,TRUE,'agent-run','scratch-maintenance','Scratch TTL expired','scratch-maintenance') RETURNING id`, [file.id, file.collection_id, file.current_version_id])).rows[0];
    await client.query('UPDATE files SET current_version_id=$2,deleted_at=$3,updated_at=$3 WHERE id=$1', [file.id, deleted.id, now]);
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [file.collection_id, file.id, deleted.id]);
  }
}
