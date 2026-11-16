// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** SQL behind remote version prepare/commit. Commit methods take the open transaction's client. */
export class RemoteVersionRepository {
  async isPurged(queryable:Queryable, fileId:string):Promise<boolean> {
    return Boolean((await queryable.query('SELECT 1 FROM file_purge_tombstones WHERE file_id=$1', [fileId])).rowCount);
  }

  /** The requested file identity and whatever file occupies the destination path, optionally row-locked. */
  async candidates(queryable:Queryable, fileId:string, collectionId:string, path:string, lock:boolean):Promise<any[]> {
    return (await queryable.query(`SELECT id,collection_id,path,current_version_id FROM files
      WHERE id=$1 OR (collection_id=$2 AND path=$3)${ lock ? ' FOR UPDATE' : '' }`, [fileId, collectionId, path])).rows;
  }

  async clearChunkUploadIntents(queryable:Queryable, versionId:string, principalId:string, actorScope:string):Promise<void> {
    await queryable.query('DELETE FROM file_share_chunk_uploads WHERE expires_at<=NOW() OR (version_id=$1 AND principal_id=$2 AND actor_scope=$3)', [versionId, principalId, actorScope]);
  }

  async upsertChunkUploadIntent(queryable:Queryable, intent:{ fileId:string; targetCollectionId:string; filePath:string; versionId:string; chunkCollectionId:string; chunkId:string; principalId:string; actorScope:string; plainSize:number }):Promise<void> {
    await queryable.query(`INSERT INTO file_share_chunk_uploads(file_id,target_collection_id,file_path,version_id,chunk_collection_id,chunk_id,principal_id,actor_scope,plain_size)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(version_id,chunk_id,principal_id,actor_scope) DO UPDATE SET file_id=EXCLUDED.file_id,target_collection_id=EXCLUDED.target_collection_id,file_path=EXCLUDED.file_path,chunk_collection_id=EXCLUDED.chunk_collection_id,plain_size=EXCLUDED.plain_size,uploaded_at=NULL,expires_at=NOW()+INTERVAL '30 minutes'`, [intent.fileId, intent.targetCollectionId, intent.filePath, intent.versionId, intent.chunkCollectionId, intent.chunkId, intent.principalId, intent.actorScope, intent.plainSize]);
  }

  async versionExists(queryable:Queryable, versionId:string):Promise<boolean> {
    return Boolean((await queryable.query('SELECT 1 FROM file_versions WHERE id=$1', [versionId])).rowCount);
  }

  async uploadedChunkIds(queryable:Queryable, versionId:string, principalId:string, actorScope:string):Promise<Set<string>> {
    const uploaded = await queryable.query(`SELECT chunk_id FROM file_share_chunk_uploads WHERE version_id=$1 AND principal_id=$2 AND actor_scope=$3 AND expires_at>NOW() AND uploaded_at IS NOT NULL`, [versionId, principalId, actorScope]);
    return new Set(uploaded.rows.map(row => row.chunk_id));
  }

  /** Serializes commits to one collection path for the rest of the transaction. */
  async lockCommitPath(client:pg.PoolClient, collectionId:string, path:string):Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`version-commit:${ collectionId }:${ path }`]);
  }

  async priorVersion(client:pg.PoolClient, versionId:string):Promise<any | undefined> {
    return (await client.query('SELECT file_id,chunk_collection_id,manifest_hash,size,deleted FROM file_versions WHERE id=$1', [versionId])).rows[0];
  }

  async keyContext(client:pg.PoolClient, versionId:string):Promise<any | undefined> {
    return (await client.query('SELECT collection_id,principal_id,key_version,key_epoch FROM file_version_key_contexts WHERE version_id=$1', [versionId])).rows[0];
  }

  /** Inserts the manifest if new and returns what is stored under its hash. */
  async storeManifest(client:pg.PoolClient, manifest:{ hash:string; chunk_ids:unknown; total_size:unknown }):Promise<any | undefined> {
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifest.hash, JSON.stringify(manifest.chunk_ids), manifest.total_size]);
    return (await client.query('SELECT chunk_ids,total_size FROM manifests WHERE hash=$1', [manifest.hash])).rows[0];
  }

  async referenceChunk(client:pg.PoolClient, collectionId:string, chunk:{ id:string; size:unknown; stored_size:unknown; location:unknown }):Promise<void> {
    await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(collection_id,id) DO UPDATE SET refcount=chunks.refcount+1', [collectionId, chunk.id, chunk.size, chunk.stored_size, chunk.location]);
  }

  async upsertFile(client:pg.PoolClient, file:{ id:string; collectionId:string; path:string; createdByType:string; createdById:string; mime:unknown; size:unknown; deletedAt:Date | null }):Promise<void> {
    await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,mime=EXCLUDED.mime,size=EXCLUDED.size,deleted_at=$8,updated_at=NOW()`, [file.id, file.collectionId, file.path, file.createdByType, file.createdById, file.mime, file.size, file.deletedAt]);
  }

  async upsertSearchText(client:pg.PoolClient, fileId:string, path:string, searchText:unknown):Promise<void> {
    await client.query(`INSERT INTO file_search_text(file_id,path,search_text) VALUES($1,$2,$3)
      ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,search_text=EXCLUDED.search_text`, [fileId, path, searchText]);
  }

  async insertVersion(client:pg.PoolClient, values:unknown[]):Promise<void> {
    await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, values);
  }

  async insertKeyContext(client:pg.PoolClient, versionId:string, context:{ collectionId:string; principalId:string; keyVersion:number; epoch:number }):Promise<void> {
    await client.query('INSERT INTO file_version_key_contexts(version_id,collection_id,principal_id,key_version,key_epoch) VALUES($1,$2,$3,$4,$5)', [versionId, context.collectionId, context.principalId, context.keyVersion, context.epoch]);
  }

  /** Moves the file's head only if it is still at `expected`; returns whether it moved. */
  async advanceHead(client:pg.PoolClient, fileId:string, versionId:string, deletedAt:Date | null, expected:string | null):Promise<boolean> {
    const advanced = await client.query('UPDATE files SET current_version_id=$2,deleted_at=$3 WHERE id=$1 AND current_version_id IS NOT DISTINCT FROM $4', [fileId, versionId, deletedAt, expected]);
    return advanced.rowCount === 1;
  }

  async journal(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string, op:string):Promise<void> {
    await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [collectionId, fileId, versionId, op]);
  }

  async deleteChunkUploadIntents(client:pg.PoolClient, versionId:string, principalId:string, actorScope:string):Promise<void> {
    await client.query('DELETE FROM file_share_chunk_uploads WHERE version_id=$1 AND principal_id=$2 AND actor_scope=$3', [versionId, principalId, actorScope]);
  }
}
