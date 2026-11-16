// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** A new version row, exactly as VersionWriter inserts it. */
export interface VersionRowInput {
  id:string;
  fileId:string;
  collectionId:string;
  parentVersionId:string | null;
  manifestHash:string;
  size:number;
  createdByType:string;
  createdById:string;
  message:string;
  deviceId:string;
  publicationStatus:string | null;
}

/**
 * The metadata statements of one version write (moved verbatim from app.ts insertVersion).
 * Every method runs on the caller's transaction client; chunk content is staged before it opens.
 */
export class VersionWriteRepository {
  async recordManifest(client:pg.PoolClient, hash:string, chunkIds:string[], totalSize:number):Promise<void> {
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [hash, JSON.stringify(chunkIds), totalSize]);
  }

  async recordChunk(client:pg.PoolClient, collectionId:string, chunk:{ id:string; size:number; storedSize:number }):Promise<void> {
    await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING`, [collectionId, chunk.id, chunk.size, chunk.storedSize, `chunks/${ collectionId }/${ chunk.id }`]);
  }

  async lockFile(client:pg.PoolClient, fileId:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  async createFileWithId(client:pg.PoolClient, fileId:string, collectionId:string, path:string, createdByType:string, createdById:string, mime:string, size:number):Promise<any> {
    return (await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [fileId, collectionId, path, createdByType, createdById, mime, size])).rows[0];
  }

  async reviveFile(client:pg.PoolClient, fileId:string, path:string, mime:string, size:number):Promise<void> {
    await client.query('UPDATE files SET path=$2,mime=$3,size=$4,deleted_at=NULL,updated_at=NOW() WHERE id=$1', [fileId, path, mime, size]);
  }

  async createFile(client:pg.PoolClient, collectionId:string, path:string, createdByType:string, createdById:string, mime:string, size:number):Promise<any> {
    return (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [collectionId, path, createdByType, createdById, mime, size])).rows[0];
  }

  async insertVersion(client:pg.PoolClient, row:VersionRowInput):Promise<any> {
    return (await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id,publication_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$4,$11) RETURNING *`, [row.id, row.fileId, row.collectionId, row.parentVersionId, row.manifestHash, row.size, row.createdByType, row.createdById, row.message, row.deviceId, row.publicationStatus])).rows[0];
  }

  async setCurrentVersion(client:pg.PoolClient, fileId:string, versionId:string):Promise<void> {
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
  }

  async auditDraftWrite(client:pg.PoolClient, whoType:string, whoId:string, deviceId:string | null, fileId:string, versionId:string, details:Record<string, unknown>):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES($1,$2,$3,$4,$5,'draft-write',$6)`, [whoType, whoId, deviceId, fileId, versionId, details]);
  }

  async referenceChunks(client:pg.PoolClient, collectionId:string, chunkIds:string[]):Promise<void> {
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, chunkIds]);
  }

  async journalPut(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string):Promise<void> {
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collectionId, fileId, versionId]);
  }
}
