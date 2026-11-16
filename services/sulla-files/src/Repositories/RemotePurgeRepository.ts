// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { RemotePurgePlan } from '../PathOperationPlan.js';

export interface PurgeTarget { path:string; current_version_id:string; operation_revision:string | number; root_id:string | null; content_hash:string | null; size:string | null; mtime_ms:string | null }

/** SQL for applying a replicated permanent purge: journal holds, the purge plan, and the purge commit itself. */
export class RemotePurgeRepository {
  constructor(private readonly db:pg.Pool) {}

  async activeHold(collectionId:string, fileId:string):Promise<string | undefined> {
    return (await this.db.query(`SELECT operation_id FROM files_path_operations WHERE state IN('planned','publishing','db-committed','undo-planned','undo-publishing','undo-db-committed')
        AND (plan->>'collectionId'=$1 OR plan::text LIKE $2) LIMIT 1`,[collectionId,`%${fileId}%`])).rows[0]?.operation_id;
  }

  async target(fileId:string, collectionId:string):Promise<PurgeTarget | undefined> {
    return (await this.db.query(`SELECT f.path,f.current_version_id,f.operation_revision,w.root_id,w.content_hash,w.size,w.mtime_ms
        FROM files f LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id WHERE f.id=$1 AND f.collection_id=$2`,[fileId,collectionId])).rows[0];
  }

  async plan(operationId:string, plan:RemotePurgePlan):Promise<void> {
    await this.db.query(`INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,'trash','planned',$2)`,[operationId,plan]);
    await this.db.query("UPDATE files_path_operations SET state='publishing',updated_at=NOW() WHERE operation_id=$1",[operationId]);
  }

  async trustReplication(client:pg.PoolClient):Promise<void> {
    await client.query("SET LOCAL sulla.trusted_replication='on'");
  }

  async lockUnchangedTarget(client:pg.PoolClient, fileId:string, collectionId:string, target:PurgeTarget):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM files WHERE id=$1 AND collection_id=$2 AND path=$3 AND current_version_id=$4 AND operation_revision=$5 FOR UPDATE',[fileId,collectionId,target.path,target.current_version_id,target.operation_revision])).rowCount);
  }

  async lockUnchangedPlan(client:pg.PoolClient, operationId:string, fileId:string, target:PurgeTarget):Promise<boolean> {
    return Boolean((await client.query("SELECT 1 FROM files_path_operations WHERE operation_id=$1 AND state='publishing' AND plan->>'fileId'=$2 AND plan->>'versionId'=$3 AND plan->>'revision'=$4 FOR UPDATE",[operationId,fileId,target.current_version_id,String(target.operation_revision)])).rowCount);
  }

  async lockTrashReceipt(client:pg.PoolClient, fileId:string, versionId:string):Promise<any> {
    return (await client.query(`SELECT * FROM files_database_operation_receipts WHERE file_id=$1 AND action='trash'
          AND after_state->>'versionId'=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[fileId,versionId])).rows[0];
  }

  /** Tombstone, detach audit history, clear holds, then delete the file and its journal/custody rows. */
  async purge(client:pg.PoolClient, input:{ collectionId:string; fileId:string; path:string; lifecycleGeneration:number; at:string | null }):Promise<void> {
    await client.query(`INSERT INTO file_purge_tombstones(collection_id,file_id,path,lifecycle_generation,audience,purged_at)
          VALUES($1,$2,$3,$4,'{"users":[],"groups":[]}'::jsonb,COALESCE($5,NOW()))
          ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,lifecycle_generation=GREATEST(file_purge_tombstones.lifecycle_generation,EXCLUDED.lifecycle_generation),purged_at=EXCLUDED.purged_at`,
    [input.collectionId, input.fileId, input.path, input.lifecycleGeneration, input.at]);
    await client.query('UPDATE audit_log SET file_id=NULL,version_id=NULL WHERE file_id=$1 OR version_id IN(SELECT id FROM file_versions WHERE file_id=$1)', [input.fileId]);
    await client.query(`UPDATE files SET record_lock_type='none',retention_mode='none',retain_until=NULL,retention_event_type=NULL,retention_event_at=NULL,
          retention_duration_days=NULL,disposal_status='approved',draft_version_id=NULL,published_version_id=NULL,current_version_id=NULL,
          lifecycle_generation=GREATEST(lifecycle_generation,$2) WHERE id=$1`, [input.fileId, input.lifecycleGeneration]);
    await client.query('DELETE FROM journal WHERE file_id=$1', [input.fileId]);
    await client.query('DELETE FROM files WHERE id=$1 AND collection_id=$2', [input.fileId, input.collectionId]);
    await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2', [input.collectionId, input.fileId]);
  }

  async markCommitted(client:pg.PoolClient, operationId:string):Promise<boolean> {
    return (await client.query("UPDATE files_path_operations SET state='db-committed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1 AND state='publishing'",[operationId])).rowCount===1;
  }
}
