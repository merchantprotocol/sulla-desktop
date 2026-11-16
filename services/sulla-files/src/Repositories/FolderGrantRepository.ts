// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Folder grants (folder_shares), folder public links and per-file grant signatures inside a folder subtree. */
export class FolderGrantRepository {
  async shares(client:Queryable, collectionId:string, path:string, lock = false):Promise<any[]> {
    return (await client.query("SELECT * FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id" + (lock ? ' FOR UPDATE' : ''), [collectionId, path])).rows;
  }

  async links(client:Queryable, collectionId:string, path:string, lock = false):Promise<any[]> {
    return (await client.query("SELECT * FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id" + (lock ? ' FOR UPDATE' : ''), [collectionId, path])).rows;
  }

  async lockSharePaths(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT id,folder_path FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE", [collectionId, path])).rows;
  }

  async lockLinkPaths(client:Queryable, collectionId:string, path:string):Promise<any[]> {
    return (await client.query("SELECT id,folder_path FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE", [collectionId, path])).rows;
  }

  async fileSharesSignature(client:Queryable, fileIds:string[]):Promise<string> {
    return (await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_shares item WHERE item.file_id=ANY($1::uuid[])", [fileIds])).rows[0].signature;
  }

  async fileLinksSignature(client:Queryable, fileIds:string[]):Promise<string> {
    return (await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_share_links item WHERE item.file_id=ANY($1::uuid[])", [fileIds])).rows[0].signature;
  }

  /** Cross-collection copy refuses any active link on the files or the source folder subtree. */
  async activeLinkInSubtree(client:Queryable, fileIds:string[], collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_share_links WHERE revoked_at IS NULL AND (file_id=ANY($1::uuid[]) OR (collection_id=$2 AND folder_path IS NOT NULL AND ($3=folder_path OR starts_with(folder_path,$3||\'/\'))) ) LIMIT 1', [fileIds, collectionId, path])).rowCount);
  }

  async activeFileLink(client:Queryable, fileIds:string[]):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_share_links WHERE file_id=ANY($1::uuid[]) AND revoked_at IS NULL LIMIT 1', [fileIds])).rowCount);
  }

  async moveShare(client:Queryable, id:string, path:string):Promise<void> {
    await client.query('UPDATE folder_shares SET folder_path=$2,updated_at=NOW() WHERE id=$1', [id, path]);
  }

  async moveLink(client:Queryable, id:string, path:string):Promise<void> {
    await client.query('UPDATE file_share_links SET folder_path=$2,updated_at=NOW() WHERE id=$1', [id, path]);
  }

  async copyShare(client:Queryable, collectionId:string, path:string, grant:any, createdBy:string):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [collectionId, path, grant.principal_type, grant.principal_id, grant.role, createdBy])).rows[0];
  }

  async transferShare(client:Queryable, id:string, collectionId:string, path:string):Promise<void> {
    await client.query('UPDATE folder_shares SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1', [id, collectionId, path]);
  }

  async transferLink(client:Queryable, id:string, collectionId:string, path:string):Promise<void> {
    await client.query('UPDATE file_share_links SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1', [id, collectionId, path]);
  }

  /** Undo of a cross-collection copy: drop the exact grant the copy created. */
  async deleteCopiedShare(client:Queryable, id:string, collectionId:string, path:string):Promise<void> {
    await client.query('DELETE FROM folder_shares WHERE id=$1 AND collection_id=$2 AND folder_path=$3', [id, collectionId, path]);
  }

  async revertShare(client:Queryable, id:string, collectionId:string, path:string, fromCollectionId:string, fromPath:string):Promise<void> {
    await client.query('UPDATE folder_shares SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1 AND collection_id=$4 AND folder_path=$5', [id, collectionId, path, fromCollectionId, fromPath]);
  }

  async revertLink(client:Queryable, id:string, collectionId:string, path:string, fromCollectionId:string, fromPath:string):Promise<void> {
    await client.query('UPDATE file_share_links SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1 AND collection_id=$4 AND folder_path=$5', [id, collectionId, path, fromCollectionId, fromPath]);
  }

  async revertSharePath(client:Queryable, id:string, path:string, fromPath:string):Promise<void> {
    await client.query('UPDATE folder_shares SET folder_path=$2,updated_at=NOW() WHERE id=$1 AND folder_path=$3', [id, path, fromPath]);
  }

  async revertLinkPath(client:Queryable, id:string, path:string, fromPath:string):Promise<void> {
    await client.query('UPDATE file_share_links SET folder_path=$2,updated_at=NOW() WHERE id=$1 AND folder_path=$3', [id, path, fromPath]);
  }
}
