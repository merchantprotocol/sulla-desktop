// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export interface WatchedRow { collection_id: string; root_id: string; path: string; file_id: string; content_hash: string; size: string; mtime_ms: string; role?: string }

export interface WatchedStateInput { collectionId:string; path:string; fileId:string; contentHash:string; size:number; mtimeMs:number; rootId:string }

/**
 * SQL for scanning native tracked roots: root/runtime progress rows, watched_folder_state custody,
 * and the statements a watched-file ingest or soft delete commits. Transactional statements take
 * the caller's client; progress and lookups use the injected pool.
 */
export class WatchedFolderRepository {
  constructor(private readonly db:pg.Pool) {}

  async pendingPathOperation():Promise<string | undefined> {
    return (await this.db.query("SELECT operation_id FROM files_path_operations WHERE state IN('planned','publishing','db-committed','undo-planned','undo-publishing','undo-db-committed') LIMIT 1")).rows[0]?.operation_id;
  }

  async markRootFailed(rootId:string, message:string):Promise<void> {
    await this.db.query("UPDATE file_roots SET state='error',last_error=$2,pending_files=0,updated_at=NOW() WHERE id=$1", [rootId, message]);
  }

  async markRootScanning(rootId:string):Promise<void> {
    await this.db.query("UPDATE file_roots SET state='scanning',pending_files=0,last_error=NULL,updated_at=NOW() WHERE id=$1", [rootId]);
  }

  async setRootPending(rootId:string, pendingFiles:number):Promise<void> {
    await this.db.query("UPDATE files_runtime_state SET state='syncing',pending_files=$1,updated_at=NOW() WHERE id=TRUE", [pendingFiles]);
    await this.db.query("UPDATE file_roots SET state='scanning',pending_files=$2,updated_at=NOW() WHERE id=$1", [rootId, pendingFiles]);
  }

  async markRuntimeScanned():Promise<void> {
    await this.db.query("UPDATE files_runtime_state SET state='synced',pending_files=0,last_error=NULL,last_scan_at=NOW(),updated_at=NOW() WHERE id=TRUE");
  }

  async finishRootScan(rootId:string, scanError:string | null):Promise<void> {
    await this.db.query("UPDATE file_roots SET state=$2,pending_files=0,last_error=$3,last_scan_at=NOW(),updated_at=NOW() WHERE id=$1", [rootId, scanError
      ? 'error'
      : 'idle', scanError]);
  }

  /** Watched rows whose bytes are expected on disk (online-only files are excluded). */
  async localStates(rootId:string):Promise<WatchedRow[]> {
    return (await this.db.query<WatchedRow>(`SELECT w.* FROM watched_folder_state w LEFT JOIN file_residency r ON r.file_id=w.file_id WHERE w.root_id=$1 AND COALESCE(r.state,'local')<>'online-only'`, [rootId])).rows;
  }

  async rootStates(rootId:string):Promise<WatchedRow[]> {
    return (await this.db.query<WatchedRow>('SELECT * FROM watched_folder_state WHERE root_id=$1', [rootId])).rows;
  }

  async refreshStat(collectionId:string, path:string, size:number, mtimeMs:number):Promise<void> {
    await this.db.query('UPDATE watched_folder_state SET size=$3,mtime_ms=$4 WHERE collection_id=$1 AND path=$2', [collectionId, path, size, Math.trunc(mtimeMs)]);
  }

  async fileAtPath(collectionId:string, path:string):Promise<{ id:string; deleted_at:Date | null; manifest_hash:string | null } | undefined> {
    return (await this.db.query(`SELECT f.id,f.deleted_at,v.manifest_hash FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id
      WHERE f.collection_id=$1 AND f.path=$2`, [collectionId, path])).rows[0];
  }

  async upsertState(client:Queryable, input:WatchedStateInput):Promise<void> {
    await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`, [input.collectionId, input.path, input.fileId, input.contentHash, input.size, Math.trunc(input.mtimeMs), input.rootId]);
  }

  async deleteState(client:Queryable, collectionId:string, path:string):Promise<void> {
    await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND path=$2', [collectionId, path]);
  }

  async insertManifest(client:pg.PoolClient, manifestHash:string, chunkIds:string[], total:number):Promise<void> {
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifestHash, JSON.stringify(chunkIds), total]);
  }

  async registerChunk(client:pg.PoolClient, collectionId:string, chunk:{ id:string; size:number; storedSize:number }):Promise<void> {
    await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING', [collectionId, chunk.id, chunk.size, chunk.storedSize, `chunks/${ collectionId }/${ chunk.id }`]);
  }

  async lockCurrentVersion(client:pg.PoolClient, fileId:string):Promise<{ current_version_id:string | null } | undefined> {
    return (await client.query('SELECT current_version_id FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  async reopenForNewContent(client:pg.PoolClient, fileId:string, path:string, mime:string, size:number):Promise<void> {
    await client.query("UPDATE files SET path=$2,mime=$3,size=$4,extracted_at=NULL,extraction_status='pending',deleted_at=NULL,updated_at=NOW() WHERE id=$1", [fileId, path, mime, size]);
    await client.query('UPDATE file_search_text SET search_text=NULL WHERE file_id=$1', [fileId]);
  }

  async createFile(client:pg.PoolClient, collectionId:string, path:string, userId:string, mime:string, size:number):Promise<string> {
    return (await client.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,extraction_status) VALUES($1,$2,'user',$3,$4,$5,'pending') RETURNING id", [collectionId, path, userId, mime, size])).rows[0].id;
  }

  async createVersion(client:pg.PoolClient, input:{ fileId:string; collectionId:string; parent:string | null; manifestHash:string; size:number; userId:string; message:string; deviceId:string }):Promise<string> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,$3) RETURNING id`, [input.fileId, input.collectionId, input.parent, input.manifestHash, input.size, input.userId, input.message, input.deviceId])).rows[0].id;
  }

  async activateVersion(client:pg.PoolClient, fileId:string, versionId:string, collectionId:string, chunkIds:string[]):Promise<void> {
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]); await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, chunkIds]);
  }

  async appendJournal(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string, op:string):Promise<void> {
    await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [collectionId, fileId, versionId, op]);
  }

  async queueRecordingEnrichment(fileId:string, versionId:string):Promise<void> {
    await this.db.query(`INSERT INTO recording_enrichment_jobs(file_id,version_id,status) VALUES($1,$2,'pending') ON CONFLICT(version_id) DO NOTHING`, [fileId, versionId]);
  }

  async createDeleteVersion(client:pg.PoolClient, row:WatchedRow, parent:string | null, userId:string, deviceId:string):Promise<string> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,NULL,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [row.file_id, row.collection_id, parent, userId, deviceId])).rows[0].id;
  }

  async trashFile(client:pg.PoolClient, row:WatchedRow, versionId:string):Promise<void> {
    await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [row.file_id, versionId]); await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [row.collection_id, row.file_id, versionId]); await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND path=$2', [row.collection_id, row.path]);
  }
}
