// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * files_path_operations (the native operation journal) and watched_folder_state (native custody).
 * Journal progress is written through the pool so it survives the receipt transaction's rollback;
 * custody rows and the final db-committed transition go through the receipt transaction's client.
 */
export class NativeOperationJournalRepository {
  async lockWatched(client:Queryable, fileIds:unknown[]):Promise<any[]> {
    return (await client.query('SELECT * FROM watched_folder_state WHERE file_id=ANY($1::uuid[]) FOR UPDATE', [fileIds])).rows;
  }

  async forgetWatched(client:Queryable, fileId:string):Promise<void> {
    await client.query('DELETE FROM watched_folder_state WHERE file_id=$1', [fileId]);
  }

  async watch(client:Queryable, collectionId:string, path:string, fileId:string, hash:string, size:number, mtimeMs:number, rootId:string):Promise<void> {
    await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`,
    [collectionId, path, fileId, hash, size, mtimeMs, rootId]);
  }

  async find(db:Queryable, operationId:string):Promise<any> {
    return (await db.query('SELECT * FROM files_path_operations WHERE operation_id=$1', [operationId])).rows[0];
  }

  /** Records the plan as 'planned', then marks it 'publishing' before the first native leaf. */
  async startPublishing(db:Queryable, operationId:string, action:string, plan:unknown):Promise<void> {
    await db.query(`INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,$2,'planned',$3)`, [operationId, action, plan]);
    await db.query("UPDATE files_path_operations SET state='publishing' WHERE operation_id=$1", [operationId]);
  }

  /** Records the inverse plan as 'undo-planned', then marks it 'undo-publishing'. */
  async startUndoPublishing(db:Queryable, operationId:string, plan:unknown):Promise<void> {
    await db.query("UPDATE files_path_operations SET state='undo-planned',plan=$2,updated_at=NOW() WHERE operation_id=$1", [operationId, plan]);
    await db.query("UPDATE files_path_operations SET state='undo-publishing' WHERE operation_id=$1", [operationId]);
  }

  async markDbCommitted(client:Queryable, operationId:string, plan:unknown):Promise<void> {
    await client.query("UPDATE files_path_operations SET state='db-committed',plan=$2,updated_at=NOW() WHERE operation_id=$1", [operationId, plan]);
  }

  async markUndoDbCommitted(client:Queryable, operationId:string, plan:unknown):Promise<void> {
    await client.query("UPDATE files_path_operations SET state='undo-db-committed',plan=$2,updated_at=NOW() WHERE operation_id=$1", [operationId, plan]);
  }

  async savePlan(db:Queryable, operationId:string, plan:unknown):Promise<void> {
    await db.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1', [operationId, plan]);
  }

  async markCompleted(db:Queryable, operationId:string):Promise<void> {
    await db.query("UPDATE files_path_operations SET state='completed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1", [operationId]);
  }

  async markCompletedWithPlan(db:Queryable, operationId:string, plan:unknown):Promise<void> {
    await db.query("UPDATE files_path_operations SET state='completed',plan=$2,last_error=NULL,updated_at=NOW() WHERE operation_id=$1", [operationId, plan]);
  }

  async markUndone(db:Queryable, operationId:string):Promise<void> {
    await db.query("UPDATE files_path_operations SET state='undone',last_error=NULL,updated_at=NOW() WHERE operation_id=$1", [operationId]);
  }

  async markRolledBack(db:Queryable, operationId:string):Promise<void> {
    await db.query("UPDATE files_path_operations SET state='rolled-back',last_error=NULL,updated_at=NOW() WHERE operation_id=$1", [operationId]);
  }

  async markState(db:Queryable, operationId:string, state:string):Promise<void> {
    await db.query('UPDATE files_path_operations SET state=$2,last_error=NULL,updated_at=NOW() WHERE operation_id=$1', [operationId, state]);
  }

  /** The exact database state of the files, folders and custody rows an operation touched. */
  async capture(client:Queryable, fileIds:string[], folderIds:string[]):Promise<{ files:any[]; folders:any[]; watched:any[] }> {
    const files = (await client.query(`SELECT id::text,collection_id::text,path,current_version_id::text,operation_revision::text,deleted_at IS NOT NULL AS deleted
      FROM files WHERE id=ANY($1::uuid[]) ORDER BY id`, [fileIds])).rows;
    const folders = (await client.query(`SELECT id::text,collection_id::text,path,operation_revision::text,deleted_at IS NOT NULL AS deleted
      FROM file_folders WHERE id=ANY($1::uuid[]) ORDER BY id`, [folderIds])).rows;
    const watched = (await client.query(`SELECT file_id::text,collection_id::text,root_id,path,content_hash,size::text,mtime_ms::text
      FROM watched_folder_state WHERE file_id=ANY($1::uuid[]) ORDER BY file_id`, [fileIds])).rows;
    return { files, folders, watched };
  }
}
