// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Files API write statements (moved verbatim from app.ts); transactional ones take the caller's client. */
export class FileWriteRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Whether a file or folder row (live or not) already holds the path. */
  async pathOccupied(client:pg.PoolClient, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND path=$2
      UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1`, [collectionId, path])).rowCount);
  }

  /** The shortest file path among the given parent paths (a file blocking a folder). */
  async blockingParent(client:pg.PoolClient, collectionId:string, parentPaths:string[]):Promise<string | undefined> {
    return (await client.query('SELECT path FROM files WHERE collection_id=$1 AND path=ANY($2::text[]) ORDER BY length(path),path LIMIT 1', [collectionId, parentPaths])).rows[0]?.path;
  }

  async folderHasFiles(client:pg.PoolClient, collectionId:string, folderPath:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1
      AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [collectionId, folderPath])).rowCount);
  }

  async folderHasTombstones(client:pg.PoolClient, collectionId:string, folderPath:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM file_folders WHERE collection_id=$1 AND deleted_at IS NOT NULL AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [collectionId, folderPath])).rowCount);
  }

  /** Deletes the folder rows of a subtree; answers how many were removed. */
  async deleteFolderTree(client:pg.PoolClient, collectionId:string, folderPath:string):Promise<number> {
    return (await client.query(`DELETE FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, folderPath])).rowCount ?? 0;
  }

  async deleteFolderStars(client:pg.PoolClient, collectionId:string, folderPath:string):Promise<void> {
    await client.query(`DELETE FROM file_stars WHERE collection_id=$1 AND folder_path IS NOT NULL
      AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))`, [collectionId, folderPath]);
  }

  async lockConflictSource(client:pg.PoolClient, conflictFileId:string):Promise<string | undefined> {
    return (await client.query('SELECT source_file_id FROM files_native_conflicts WHERE file_id=$1 FOR UPDATE', [conflictFileId])).rows[0]?.source_file_id;
  }

  async lockFileStates(client:pg.PoolClient, fileIds:string[]):Promise<any[]> {
    return (await client.query('SELECT id,current_version_id,deleted_at FROM files WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [fileIds])).rows;
  }

  async hasUnresolvedNativePublication(client:pg.PoolClient, fileIds:string[]):Promise<boolean> {
    return Boolean((await client.query(`SELECT operation_id FROM files_native_source_operations
      WHERE file_id=ANY($1::uuid[]) AND state IN('publishing','recovery-required') ORDER BY operation_id FOR UPDATE`, [fileIds])).rowCount);
  }

  async deleteConflict(client:pg.PoolClient, conflictFileId:string, sourceFileId:string):Promise<number> {
    return (await client.query('DELETE FROM files_native_conflicts WHERE file_id=$1 AND source_file_id=$2', [conflictFileId, sourceFileId])).rowCount ?? 0;
  }

  async auditKeepBoth(client:pg.PoolClient, whoType:string, whoId:string, deviceId:string | null, fileId:string, versionId:string, details:string):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'conflict-keep-both',$6)`, [whoType, whoId, deviceId, fileId, versionId, details]);
  }

  async liveVersionId(versionId:string, fileId:string):Promise<string | undefined> {
    return (await this.db.query('SELECT id FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted', [versionId, fileId])).rows[0]?.id;
  }

  async fileAt(collectionId:string, path:string):Promise<any> {
    return (await this.db.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2', [collectionId, path])).rows[0];
  }

  async lockFileAt(client:pg.PoolClient, collectionId:string, path:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collectionId, path])).rows[0];
  }
}
