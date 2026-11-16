// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/** Statements of the permanent-disposal (Trash purge) transaction. Every method runs on its client. */
export class FilePurgeRepository {
  async hasActiveShareLink(client:Queryable, fileId:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_share_links WHERE file_id=$1 AND revoked_at IS NULL LIMIT 1', [fileId])).rowCount);
  }

  async lockTrashReceipt(client:Queryable, fileId:string, versionId:string):Promise<any> {
    return (await client.query(`SELECT * FROM files_database_operation_receipts WHERE file_id=$1 AND action='trash' AND after_state->>'versionId'=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[fileId,versionId])).rows[0];
  }

  async lockPathOperation(client:Queryable, operationId:string):Promise<any> {
    return (await client.query('SELECT * FROM files_path_operations WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];
  }

  async updateReceiptPlan(client:Queryable, receiptId:string, plan:unknown):Promise<void> {
    await client.query('UPDATE files_database_operation_receipts SET folder_plan=$2 WHERE id=$1',[receiptId,plan]);
  }

  async updateOperationPlan(client:Queryable, operationId:string, plan:unknown):Promise<void> {
    await client.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1',[operationId,plan]);
  }

  async fileChunks(client:Queryable, fileId:string):Promise<pg.QueryResult> {
    return client.query(`SELECT DISTINCT v.chunk_collection_id,jsonb_array_elements_text(m.chunk_ids) chunk_id
        FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.file_id=$1`, [fileId]);
  }

  async versionIds(client:Queryable, fileId:string):Promise<string[]> {
    return (await client.query('SELECT id::text FROM file_versions WHERE file_id=$1 ORDER BY created_at,id', [fileId])).rows.map(row => row.id);
  }

  async insertPurgeAudit(client:Queryable, whoType:string, whoId:string, deviceId:string | null, details:unknown):Promise<any> {
    return (await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,action,details)
        VALUES($1,$2,$3,'disposal-purge',$4) RETURNING id`, [whoType, whoId, deviceId, details])).rows[0].id;
  }

  /** Records the purge for every user/group that could see the file, so their devices drop it. */
  async upsertTombstone(client:Queryable, collectionId:string, fileId:string, path:string, lifecycleGeneration:number):Promise<void> {
    await client.query(`INSERT INTO file_purge_tombstones(collection_id,file_id,path,lifecycle_generation,audience)
        SELECT $1,$2,$3,$4,jsonb_build_object(
          'users',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT owner_user_id principal FROM collections WHERE id=$1
            UNION SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='user' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='user') users)),
          'groups',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='group' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='group') groups)))
        ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,lifecycle_generation=GREATEST(file_purge_tombstones.lifecycle_generation,EXCLUDED.lifecycle_generation),audience=EXCLUDED.audience,purged_at=NOW()`, [collectionId, fileId, path, lifecycleGeneration]);
  }

  /** Removes the file's metadata rows in dependency order (journal, audit refs, share links, version pointers, file). */
  async deleteFileRows(client:Queryable, fileId:string):Promise<void> {
    await client.query('DELETE FROM journal WHERE file_id=$1', [fileId]);
    await client.query('UPDATE audit_log SET file_id=NULL,version_id=NULL WHERE file_id=$1 OR version_id IN(SELECT id FROM file_versions WHERE file_id=$1)', [fileId]);
    await client.query('DELETE FROM file_share_links WHERE file_id=$1', [fileId]);
    await client.query('UPDATE files SET current_version_id=NULL,draft_version_id=NULL,published_version_id=NULL WHERE id=$1', [fileId]);
    await client.query('DELETE FROM files WHERE id=$1', [fileId]);
  }
}
