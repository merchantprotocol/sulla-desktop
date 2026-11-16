// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Restoring an older version as a new current version that shares its manifest (SQL moved verbatim from app.ts). */
export class VersionRestoreRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async liveVersion(versionId:string, fileId:string):Promise<any> {
    return (await this.db.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted', [versionId, fileId])).rows[0];
  }

  async lockLiveVersion(client:pg.PoolClient, versionId:string, fileId:string):Promise<boolean> {
    return Boolean((await client.query('SELECT id FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted FOR UPDATE', [versionId, fileId])).rowCount);
  }

  async insertRestored(client:pg.PoolClient, fileId:string, chunkCollectionId:string, parentVersionId:string, manifestHash:string, size:string | number, userId:string, comment:unknown, deviceId:string):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,version_comment,version_kind,publication_status,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,'user',$6,'Restored version',$7,'minor',NULL,$8,$3) RETURNING id`, [fileId, chunkCollectionId, parentVersionId, manifestHash, size, userId, comment, deviceId])).rows[0];
  }

  async referenceManifestChunks(client:pg.PoolClient, collectionId:string, manifestHash:string):Promise<void> {
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id IN (SELECT jsonb_array_elements_text(chunk_ids) FROM manifests WHERE hash=$2)', [collectionId, manifestHash]);
  }

  async makeCurrent(client:pg.PoolClient, fileId:string, versionId:string, size:string | number):Promise<void> {
    await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,size=$3,updated_at=NOW() WHERE id=$1', [fileId, versionId, size]);
  }

  async journalRestore(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string):Promise<void> {
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [collectionId, fileId, versionId]);
  }
}
