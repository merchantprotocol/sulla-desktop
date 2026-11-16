// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import type { PathOperationPlanEntry, PathOperationReceipt } from '../PathOperationPlan.js';

/** SQL for publishing a native move/copy: plan locks, the durable journal row, receipts and the metadata commit. */
export class PathOperationPublishRepository {
  constructor(private readonly db:pg.Pool) {}

  async collectionOf(fileId:string):Promise<string | undefined> {
    return (await this.db.query('SELECT collection_id FROM files WHERE id=$1', [fileId])).rows[0]?.collection_id;
  }

  async lockWatchedFiles(client:pg.PoolClient, collectionId:string, fileIds:string[]):Promise<pg.QueryResult> {
    return client.query(`SELECT f.*,f.id::text,w.path AS watched_path,w.content_hash,w.size AS watched_size,w.mtime_ms,f.current_version_id::text
          FROM files f JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
          WHERE f.collection_id=$1 AND f.id=ANY($2::uuid[]) AND f.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
          ORDER BY w.path FOR UPDATE OF f,w`, [collectionId, fileIds]);
  }

  /** Every stored folder in the subtree (reviewed unbounded read: one user-selected folder's subtree). */
  async lockFolderTree(client:pg.PoolClient, collectionId:string, path:string):Promise<{ path:string }[]> {
    return (await client.query(`SELECT path FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY path FOR UPDATE`, [collectionId, path])).rows;
  }

  /** Bounded at one past the planned count: any extra folder already fails the caller's equality check. */
  async relockFolderTree(client:pg.PoolClient, collectionId:string, path:string, planned:number):Promise<{ path:string }[]> {
    return (await client.query(`SELECT path FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY path LIMIT $3 FOR UPDATE`,[collectionId,path,planned+1])).rows;
  }

  async folderExists(client:pg.PoolClient, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1', [collectionId, path])).rowCount);
  }

  async folderAppeared(client:pg.PoolClient, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2',[collectionId,path])).rowCount);
  }

  async plan(client:pg.PoolClient, operationId:string, action:'move' | 'copy', plan:PathOperationPlanEntry[]):Promise<void> {
    await client.query(
      `INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,$2,'planned',$3::jsonb)`,
      [operationId, action, JSON.stringify(plan)],
    );
  }

  async markPublishing(operationId:string):Promise<void> {
    await this.db.query("UPDATE files_path_operations SET state='publishing',updated_at=NOW() WHERE operation_id=$1", [operationId]);
  }

  async appendReceipt(operationId:string, receipt:PathOperationReceipt):Promise<void> {
    await this.db.query(
      `UPDATE files_path_operations SET receipts=receipts||$2::jsonb,updated_at=NOW() WHERE operation_id=$1`,
      [operationId, JSON.stringify([receipt])],
    );
  }

  async relockWatchedFiles(client:pg.PoolClient, fileIds:string[], collectionId:string):Promise<any[]> {
    return (await client.query(`SELECT f.id,f.path,f.current_version_id,w.content_hash FROM files f
          JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
          WHERE f.id=ANY($1::uuid[]) AND f.collection_id=$2 AND f.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) FOR UPDATE OF f,w`,[fileIds,collectionId])).rows;
  }

  async moveFile(client:pg.PoolClient, collectionId:string, fileId:string, nextPath:string):Promise<void> {
    await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1', [fileId, nextPath]);
    await client.query('UPDATE watched_folder_state SET path=$3 WHERE collection_id=$1 AND file_id=$2', [collectionId, fileId, nextPath]);
  }

  async journalRename(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string):Promise<void> {
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'rename')", [collectionId, fileId, versionId]);
  }

  async auditMove(client:pg.PoolClient, actor:FilesIdentity, fileId:string, versionId:string, details:Record<string, unknown>):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES($1,$2,$3,$4,$5,'move',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, fileId, versionId, JSON.stringify(details)]);
  }

  async auditCopy(client:pg.PoolClient, actor:FilesIdentity, fileId:string, versionId:string, details:Record<string, unknown>):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES($1,$2,$3,$4,$5,'copy',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, fileId, versionId, JSON.stringify(details)]);
  }

  async watchCopy(client:pg.PoolClient, input:{ collectionId:string; path:string; fileId:string; contentHash:string; size:number; mtimeMs:number; rootId:string }):Promise<void> {
    await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id)
              VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.collectionId, input.path, input.fileId, input.contentHash, input.size, Math.trunc(input.mtimeMs), input.rootId]);
  }

  async moveFolderStars(client:pg.PoolClient, collectionId:string, sourcePath:string, targetPath:string):Promise<void> {
    const folderStars = await client.query(`SELECT principal_type,principal_id,folder_path FROM file_stars WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) FOR UPDATE`, [collectionId, sourcePath]);
    for (const star of folderStars.rows) await client.query(`UPDATE file_stars SET folder_path=$4 WHERE principal_type=$1 AND principal_id=$2 AND collection_id=$3 AND folder_path=$5`, [star.principal_type, star.principal_id, collectionId, `${ targetPath }${ star.folder_path.slice(sourcePath.length) }`, star.folder_path]);
  }

  async moveFolder(client:pg.PoolClient, collectionId:string, sourcePath:string, targetPath:string):Promise<void> {
    await client.query('UPDATE file_folders SET path=$3,updated_at=NOW() WHERE collection_id=$1 AND path=$2', [collectionId, sourcePath, targetPath]);
  }

  async markDbCommitted(client:pg.PoolClient, operationId:string):Promise<void> {
    await client.query("UPDATE files_path_operations SET state='db-committed',updated_at=NOW() WHERE operation_id=$1", [operationId]);
  }

  async settle(operationId:string, state:'publishing' | 'completed' | 'db-committed', lastError:string | null):Promise<void> {
    await this.db.query(
      `UPDATE files_path_operations SET state=$2,last_error=$3,updated_at=NOW() WHERE operation_id=$1`,
      [operationId, state, lastError],
    );
  }
}
