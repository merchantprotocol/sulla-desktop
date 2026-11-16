// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export type MigratedRowKind = 'folder' | 'file';
export interface MigrationPathRecord { source_path:string; target_path:string }
export interface StrayDocRow { id:string; collection_id:string; path:string; current_version_id:string | null }

/**
 * SQL for the one-time Sulla-collection merge and the stray bundled-Docs cleanup. Pool reads take
 * the constructor's pool; per-row moves run on the transaction's client.
 */
export class SullaCollectionMigrationRepository {
  // The home collection backs the default Files root. A folder tracked from the Mac is never home,
  // even when it happens to have an empty explorer path or no collection is flagged default yet.
  static readonly homeQuery = `SELECT c.* FROM collections c LEFT JOIN file_roots r ON r.collection_id=c.id
  WHERE c.owner_user_id=$1 AND c.published=TRUE AND c.legacy_source=FALSE AND c.system_area IS NULL
    AND (r.id IS NULL OR r.id='default')
  ORDER BY (r.id='default') DESC NULLS LAST,EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=c.id AND a.principal_type='user' AND a.principal_id=$1 AND a.role='manage') DESC,c.is_default DESC,c.created_at LIMIT 1`;

  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async findSullaCollection():Promise<any | undefined> {
    return (await this.db.query("SELECT * FROM collections WHERE system_area='sulla' LIMIT 1")).rows[0];
  }

  async findHome(ownerUserId:string):Promise<any | undefined> {
    return (await this.db.query(SullaCollectionMigrationRepository.homeQuery, [ownerUserId])).rows[0];
  }

  /** Records where each migrated folder went, so a resumed run keeps files under the same (renamed) parent. */
  async ensurePathTable():Promise<void> {
    await this.db.query(`CREATE TABLE IF NOT EXISTS sulla_collection_migration_paths(source_collection_id UUID NOT NULL,source_path TEXT NOT NULL,target_path TEXT NOT NULL,PRIMARY KEY(source_collection_id,source_path))`);
  }

  /** Parents first. Unbounded by design: one-time migration of the retired Sulla collection, moved row by row. */
  async folderIds(collectionId:string):Promise<{ id:string }[]> {
    return (await this.db.query('SELECT id FROM file_folders WHERE collection_id=$1 ORDER BY length(path),path', [collectionId])).rows;
  }

  async fileIds(collectionId:string):Promise<{ id:string }[]> {
    return (await this.db.query('SELECT id FROM files WHERE collection_id=$1 ORDER BY created_at,id', [collectionId])).rows;
  }

  async remainingRows(collectionId:string):Promise<number> {
    return Number((await this.db.query(`SELECT (SELECT count(*) FROM files WHERE collection_id=$1)+(SELECT count(*) FROM file_folders WHERE collection_id=$1) AS n`, [collectionId])).rows[0].n);
  }

  async retire(collectionId:string):Promise<void> {
    await this.db.query("UPDATE collections SET explorer_path='.sulla-retired' WHERE id=$1", [collectionId]);
  }

  /** Both collections' namespace gates, in id order so concurrent moves cannot deadlock. */
  async lockNamespaces(client:pg.PoolClient, collectionIds:string[]):Promise<void> {
    for (const id of [...collectionIds].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + id]);
  }

  async lockRow(client:pg.PoolClient, kind:MigratedRowKind, id:string):Promise<any | undefined> {
    const table = kind === 'folder' ? 'file_folders' : 'files';
    return (await client.query(`SELECT * FROM ${ table } WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  }

  async recordedTarget(client:pg.PoolClient, sourceCollectionId:string, sourcePath:string):Promise<string | undefined> {
    return (await client.query('SELECT target_path FROM sulla_collection_migration_paths WHERE source_collection_id=$1 AND source_path=$2', [sourceCollectionId, sourcePath])).rows[0]?.target_path;
  }

  /** The deepest already-migrated folder above `path`. */
  async nearestMigratedParent(client:pg.PoolClient, sourceCollectionId:string, path:string):Promise<MigrationPathRecord | undefined> {
    return (await client.query(`SELECT source_path,target_path FROM sulla_collection_migration_paths WHERE source_collection_id=$1
        AND starts_with($2,source_path||'/') ORDER BY length(source_path) DESC LIMIT 1`, [sourceCollectionId, path])).rows[0];
  }

  async isOccupied(client:pg.PoolClient, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND path=$2
    UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1`, [collectionId, path])).rowCount);
  }

  async recordTarget(client:pg.PoolClient, sourceCollectionId:string, sourcePath:string, targetPath:string):Promise<void> {
    await client.query('INSERT INTO sulla_collection_migration_paths(source_collection_id,source_path,target_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [sourceCollectionId, sourcePath, targetPath]);
  }

  async moveRow(client:pg.PoolClient, kind:MigratedRowKind, id:string, collectionId:string, path:string):Promise<void> {
    const table = kind === 'folder' ? 'file_folders' : 'files';
    await client.query(`UPDATE ${ table } SET collection_id=$2,path=$3 WHERE id=$1`, [id, collectionId, path]);
  }

  async journalRename(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string | null):Promise<void> {
    await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [collectionId, fileId, versionId, 'rename']);
  }

  async auditMove(client:pg.PoolClient, userId:string, fileId:string, versionId:string | null, details:Record<string, unknown>):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES('user',$1,'sulla-files-migration',$2,$3,'sulla-collection-migration',$4)`,
      [userId, fileId, versionId, details]);
  }

  /** Docs/ files in tracked (non-default) roots that never came from the Mac. Unbounded by design: one-time cleanup, trashed row by row. */
  async strayDocs():Promise<StrayDocRow[]> {
    return (await this.db.query(`SELECT f.id,f.collection_id,f.path,f.current_version_id FROM files f
    JOIN file_roots r ON r.collection_id=f.collection_id AND r.id<>'default'
    WHERE f.deleted_at IS NULL AND f.created_by_type='user' AND starts_with(f.path,'Docs/')
      AND NOT EXISTS(SELECT 1 FROM watched_folder_state w WHERE w.file_id=f.id)`)).rows;
  }

  async lockFileState(client:pg.PoolClient, fileId:string):Promise<{ current_version_id:string | null; deleted_at:Date | null } | undefined> {
    return (await client.query('SELECT current_version_id,deleted_at FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  /** Writes the delete version, makes it current, journals and audits it. */
  async trashStrayDoc(client:pg.PoolClient, row:StrayDocRow, currentVersionId:string | null, userId:string, deviceId:string):Promise<void> {
    const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,NULL,0,TRUE,'user',$4,'Moved to Trash: bundled Docs do not belong in a tracked folder',$5,$3) RETURNING id`, [row.id, row.collection_id, currentVersionId, userId, deviceId])).rows[0];
    await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [row.id, version.id]);
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [row.collection_id, row.id, version.id]);
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES('user',$1,'sulla-files-migration',$2,$3,'stray-docs-trashed',$4)`,
      [userId, row.id, version.id, { path: row.path, collectionId: row.collection_id }]);
  }
}
