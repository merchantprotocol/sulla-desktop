// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Reads and writes one stored folder subtree (files under it, file_folders at and under it).
 * Subtree reads are bounded per operation subtree, not by LIMIT; they are reviewed in
 * UnboundedReadGuard's allowlist.
 */
export class FolderSubtreeRepository {
  async liveFiles(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') AND deleted_at IS NULL ORDER BY path", [collectionId, path])).rows;
  }

  async liveFolders(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) AND deleted_at IS NULL ORDER BY length(path),path", [collectionId, path])).rows;
  }

  /** Every file under `path` (trashed included), locked in path order. */
  async lockFilesByPath(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') ORDER BY path FOR UPDATE", [collectionId, path])).rows;
  }

  /** The folder and every folder under it, locked shallow-first. */
  async lockFoldersByDepth(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY length(path),path FOR UPDATE", [collectionId, path])).rows;
  }

  /** Every file under `path`, locked in id order. */
  async lockFilesById(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') ORDER BY id FOR UPDATE", [collectionId, path])).rows;
  }

  /** Every file at or under `path`, locked in id order. */
  async lockFilesAtOrUnder(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT * FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY id FOR UPDATE", [collectionId, path])).rows;
  }

  /** The folder and every folder under it, locked in id order. */
  async lockFoldersById(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY id FOR UPDATE", [collectionId, path])).rows;
  }

  /** A file at, under or above `path`, or a folder at or under it. */
  async occupied(client:Queryable, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/') OR starts_with($2,path||'/'))
      UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [collectionId, path])).rowCount);
  }

  async folderAtOrUnder(client:Queryable, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query("SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1", [collectionId, path])).rowCount);
  }

  /** Undo of create-folder is refused once the folder gained children, grants or links. */
  async createdFolderInUse(client:Queryable, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))
        UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND starts_with(path,$2||'/')
        UNION ALL SELECT 1 FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))
        UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) LIMIT 1`, [collectionId, path])).rowCount);
  }

  async findFolder(client:Queryable, id:string):Promise<any> {
    return (await client.query('SELECT * FROM file_folders WHERE id=$1', [id])).rows[0];
  }

  async lockFolder(client:Queryable, id:string):Promise<any> {
    return (await client.query('SELECT * FROM file_folders WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  async insertFolder(client:Queryable, collectionId:string, path:string, createdBy:string):Promise<any> {
    return (await client.query('INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,$2,$3) RETURNING *', [collectionId, path, createdBy])).rows[0];
  }

  async renameFolder(client:Queryable, id:string, path:string):Promise<any> {
    return (await client.query('UPDATE file_folders SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [id, path])).rows[0];
  }

  async trashFolder(client:Queryable, id:string):Promise<any> {
    return (await client.query('UPDATE file_folders SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *', [id])).rows[0];
  }

  async relocateFolder(client:Queryable, id:string, collectionId:string, path:string):Promise<any> {
    return (await client.query('UPDATE file_folders SET collection_id=$2,path=$3,updated_at=NOW() WHERE id=$1 RETURNING *', [id, collectionId, path])).rows[0];
  }

  async restoreFolder(client:Queryable, id:string, path:string):Promise<void> {
    await client.query('UPDATE file_folders SET path=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1', [id, path]);
  }

  async restoreFolderTo(client:Queryable, id:string, collectionId:string, path:string):Promise<void> {
    await client.query('UPDATE file_folders SET collection_id=$2,path=$3,deleted_at=NULL,updated_at=NOW() WHERE id=$1', [id, collectionId, path]);
  }

  async deleteFolder(client:Queryable, id:string):Promise<void> {
    await client.query('DELETE FROM file_folders WHERE id=$1', [id]);
  }
}
