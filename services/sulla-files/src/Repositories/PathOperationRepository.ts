// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { PathOperationRow } from '../PathOperationPlan.js';

/** SQL for the files_path_operations recovery journal and the trash-receipt retention sweep. */
export class PathOperationRepository {
  constructor(private readonly db:pg.Pool) {}

  async unfinished():Promise<PathOperationRow[]> {
    return (await this.db.query(
      `SELECT operation_id,state,plan,receipts FROM files_path_operations
          WHERE state IN('planned','publishing','db-committed','undo-planned','undo-publishing','undo-db-committed') ORDER BY created_at`,
    )).rows as PathOperationRow[];
  }

  async markCompleted(operationId:string):Promise<void> {
    await this.db.query("UPDATE files_path_operations SET state='completed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1", [operationId]);
  }

  async recordError(operationId:string, message:string):Promise<void> {
    await this.db.query('UPDATE files_path_operations SET last_error=$2,updated_at=NOW() WHERE operation_id=$1', [operationId, message.slice(0, 2000)]);
  }

  /** Finished operations whose undo was invalidated but whose retained artifacts are not yet disposed. */
  async awaitingDisposal():Promise<{ operation_id:string }[]> {
    return (await this.db.query(`SELECT operation_id FROM files_path_operations WHERE state IN('completed','undone','rolled-back')
        AND plan#>>'{disposal,undoInvalidatedAt}' IS NOT NULL AND plan#>>'{disposal,artifactsDisposedAt}' IS NULL ORDER BY created_at`)).rows;
  }

  async find(operationId:string):Promise<any> {
    return (await this.db.query('SELECT operation_id,state,plan,receipts FROM files_path_operations WHERE operation_id=$1', [operationId])).rows[0];
  }

  async fileStillLive(fileId:string, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files WHERE id=$1 OR (collection_id=$2 AND path=$3) LIMIT 1', [fileId, collectionId, path])).rowCount);
  }

  async purgeTombstone(fileId:string):Promise<{ collection_id:string; path:string; lifecycle_generation:string | number } | undefined> {
    return (await this.db.query('SELECT collection_id,path,lifecycle_generation FROM file_purge_tombstones WHERE file_id=$1', [fileId])).rows[0];
  }

  async completeCommittedPurge(operationId:string):Promise<void> {
    await this.db.query("UPDATE files_path_operations SET state='completed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1 AND state='db-committed'", [operationId]);
  }

  async rollBackPurge(operationId:string):Promise<void> {
    await this.db.query("UPDATE files_path_operations SET state='rolled-back',last_error=NULL,updated_at=NOW() WHERE operation_id=$1 AND state IN('planned','publishing')", [operationId]);
  }

  async expiredTrashReceipts(now:Date):Promise<{ id:string }[]> {
    return (await this.db.query(`SELECT id FROM files_database_operation_receipts
        WHERE action='trash' AND state IN('completed','undone')
          AND folder_plan#>>'{lifecycle,expiresAt}' IS NOT NULL
          AND (folder_plan#>>'{lifecycle,expiresAt}')::timestamptz<=$1
          AND folder_plan#>>'{lifecycle,disposal,undoInvalidatedAt}' IS NULL ORDER BY created_at`, [now])).rows;
  }

  async lockReceipt(client:pg.PoolClient, id:string):Promise<any> {
    return (await client.query('SELECT * FROM files_database_operation_receipts WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  async lockOperation(client:pg.PoolClient, operationId:string):Promise<any> {
    return (await client.query('SELECT * FROM files_path_operations WHERE operation_id=$1 FOR UPDATE', [operationId])).rows[0];
  }

  async anyRetentionActive(client:pg.PoolClient, fileIds:string[]):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM files f WHERE f.id=ANY($1::uuid[]) AND files_retention_active(f) LIMIT 1', [fileIds])).rowCount);
  }

  async saveReceiptPlan(client:pg.PoolClient, id:string, folderPlan:unknown):Promise<void> {
    await client.query('UPDATE files_database_operation_receipts SET folder_plan=$2 WHERE id=$1', [id, folderPlan]);
  }

  async saveOperationPlan(client:pg.PoolClient, operationId:string, plan:unknown):Promise<void> {
    await client.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1', [operationId, plan]);
  }
}
