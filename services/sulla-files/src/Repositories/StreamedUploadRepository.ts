// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

export interface UploadedChunk { id:string; size:number; storedSize:number }
export interface NewFileRow { collectionId:string; path:string; createdByType:string; createdById:string; mime:string; size:number }
export interface NewVersionRow {
  fileId:string; collectionId:string; parentVersionId:string | null; manifestHash:string; size:number;
  createdByType:string; createdById:string; message:string; deviceId:string; publicationStatus:string | null;
}
export interface UploadAuditRow { whoType:string; whoId:string; deviceId:string | null; fileId:string; versionId:string; action:string; path:string }

/**
 * The metadata a streamed upload commits: manifest, chunk rows, the file and its new version,
 * refcounts, journal and audit. Every method runs on the caller's transaction client, which
 * holds BEGIN and the namespace lock.
 */
export class StreamedUploadRepository {
  /** Inserts the manifest; false when one with this hash already exists. */
  async insertManifest(client:Queryable, hash:string, chunkIds:readonly string[], totalSize:number):Promise<boolean> {
    return Boolean((await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING hash', [hash, JSON.stringify(chunkIds), totalSize])).rowCount);
  }

  async findManifest(client:Queryable, hash:string):Promise<{ chunk_ids:unknown; total_size:string | number } | undefined> {
    return (await client.query('SELECT chunk_ids,total_size FROM manifests WHERE hash=$1', [hash])).rows[0];
  }

  /** Inserts the chunk row with refcount 0; false when the row already exists. */
  async insertChunk(client:Queryable, collectionId:string, chunk:UploadedChunk, location:string):Promise<boolean> {
    return Boolean((await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount)
    VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING RETURNING id`, [collectionId, chunk.id, chunk.size, chunk.storedSize, location])).rowCount);
  }

  async findChunk(client:Queryable, collectionId:string, id:string):Promise<{ size:string | number; stored_size:string | number; location:string } | undefined> {
    return (await client.query('SELECT size,stored_size,location FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId, id])).rows[0];
  }

  async updateFile(client:Queryable, fileId:string, mime:string, size:number):Promise<any> {
    return (await client.query(`UPDATE files SET mime=$2,size=$3,updated_at=NOW() WHERE id=$1 RETURNING *`,
      [fileId, mime, size])).rows[0];
  }

  async insertFile(client:Queryable, row:NewFileRow):Promise<any> {
    return (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [row.collectionId, row.path, row.createdByType, row.createdById, row.mime, row.size])).rows[0];
  }

  async insertVersion(client:Queryable, row:NewVersionRow):Promise<any> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id,publication_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10) RETURNING *`, [row.fileId, row.collectionId, row.parentVersionId, row.manifestHash, row.size, row.createdByType, row.createdById, row.message, row.deviceId, row.publicationStatus])).rows[0];
  }

  async setCurrentVersion(client:Queryable, fileId:string, versionId:string):Promise<void> {
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
  }

  async incrementRefcounts(client:Queryable, collectionId:string, chunkIds:readonly string[]):Promise<void> {
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, chunkIds]);
  }

  async journalPut(client:Queryable, collectionId:string, fileId:string, versionId:string):Promise<void> {
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collectionId, fileId, versionId]);
  }

  async audit(client:Queryable, row:UploadAuditRow):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.whoType, row.whoId, row.deviceId, row.fileId, row.versionId, row.action, { path:row.path }]);
  }
}
