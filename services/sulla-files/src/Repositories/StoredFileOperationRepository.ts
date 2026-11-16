// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** SQL for legacy (receipt-less) stored move/copy: file rows, copied versions, folders, grants and journal. */
export class StoredFileOperationRepository {
  async copySource(client:Queryable, versionId:string):Promise<any> {
    return (await client.query(`SELECT v.*,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
    WHERE v.id=$1 AND NOT v.deleted`, [versionId])).rows[0];
  }

  async insertCopy(client:Queryable, source:any, targetPath:string, actor:FilesIdentity):Promise<any> {
    return (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,extraction_status)
    VALUES($1,$2,'user',$3,$4,$5,'pending') RETURNING *`, [source.collection_id, targetPath, actor.userId, source.mime, source.size])).rows[0];
  }

  async insertCopyVersion(client:Queryable, fileId:string, version:any, actor:FilesIdentity, sourcePath:string):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,message,device_id)
    VALUES($1,$2,$3,$4,'user',$5,$6,$7) RETURNING id`, [fileId, version.chunk_collection_id, version.manifest_hash, version.size, actor.userId, `Copied from ${ sourcePath }`, actor.deviceId || 'server-web'])).rows[0];
  }

  /** Points the copy at its version, references its chunks, journals it and queues indexing. */
  async finishCopy(client:Queryable, collectionId:string, fileId:string, versionId:string, version:any):Promise<void> {
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [version.chunk_collection_id, version.chunk_ids]);
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collectionId, fileId, versionId]);
    await client.query("INSERT INTO file_index_jobs(file_id,version_id,status) VALUES($1,$2,'pending') ON CONFLICT(version_id) DO NOTHING", [fileId, versionId]);
  }

  async lockLive(client:Queryable, id:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
  }

  /** The folder and every stored folder under it, locked in path order (bounded by the moved subtree). */
  async lockFolderPaths(client:Queryable, collectionId:string, path:string):Promise<{ rowCount:number; rows:{ path:string }[] }> {
    const rows = await client.query(`SELECT path FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY path FOR UPDATE`, [collectionId, path]);
    return { rowCount: rows.rowCount ?? 0, rows: rows.rows };
  }

  async folderExists(client:Queryable, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1', [collectionId, path])).rowCount);
  }

  /** Moves the file and its watched custody row to `path`. */
  async move(client:Queryable, id:string, path:string):Promise<any> {
    const result = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [id, path])).rows[0];
    await client.query('UPDATE watched_folder_state SET path=$2 WHERE file_id=$1', [id, path]);
    return result;
  }

  async journalRename(client:Queryable, collectionId:string, fileId:string, versionId:string):Promise<void> {
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'rename')", [collectionId, fileId, versionId]);
  }

  async audit(client:Queryable, actor:FilesIdentity, result:any, action:string, details:string):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, result.id, result.current_version_id, action, details]);
  }

  async renameFolder(client:Queryable, collectionId:string, from:string, to:string):Promise<void> {
    await client.query('UPDATE file_folders SET path=$3,updated_at=NOW() WHERE collection_id=$1 AND path=$2', [collectionId, from, to]);
  }

  /** Re-roots stars, folder grants and folder public links under a moved folder. */
  async moveFolderReferences(client:Queryable, collectionId:string, from:string, to:string):Promise<void> {
    for (const table of ['file_stars', 'folder_shares', 'file_share_links']) await client.query(`UPDATE ${ table } SET folder_path=$3||substr(folder_path,length($2)+1) WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))`, [collectionId, from, to]);
  }
}
