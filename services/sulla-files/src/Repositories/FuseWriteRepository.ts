// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Files-mount write statements (moved verbatim from app.ts); transactional ones take the caller's client. */
export class FuseWriteRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** A trashed file still holding (collection, path), locked so a create can revive it. */
  async lockTrashedAt(client:pg.PoolClient, collectionId:string, path:string):Promise<{ id:string } | undefined> {
    return (await client.query('SELECT id FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NOT NULL FOR UPDATE', [collectionId, path])).rows[0];
  }

  async describeNewFolders(client:pg.PoolClient, collectionId:string, paths:string[], description:string):Promise<void> {
    await client.query(`UPDATE file_folders SET description=$3,updated_at=NOW() WHERE collection_id=$1 AND path=ANY($2::text[]) AND description IS NULL`, [collectionId, paths, description]);
  }

  async folderHasLiveFiles(client:pg.PoolClient, collectionId:string, folderPath:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND deleted_at IS NULL AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [collectionId, folderPath])).rowCount);
  }

  async deleteFolderTree(client:pg.PoolClient, collectionId:string, folderPath:string):Promise<void> {
    await client.query(`DELETE FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, folderPath]);
  }

  /** A live version of the file, read before a mount write (outside any transaction). */
  async liveVersion(versionId:string, fileId:string):Promise<{ id:string; parent_version_id:string | null } | undefined> {
    return (await this.db.query('SELECT id,parent_version_id FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted', [versionId, fileId])).rows[0];
  }

  async trash(client:pg.PoolClient, fileId:string):Promise<void> {
    await client.query('UPDATE files SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [fileId]);
  }
}
