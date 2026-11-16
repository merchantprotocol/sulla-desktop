// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** SQL for the legacy server sync loop: runtime/root sync state, cursors, the push queue and conflict copies. */
export class LegacySyncRepository {
  constructor(private readonly db:pg.Pool) {}

  async markRuntimeSyncing():Promise<void> {
    await this.db.query("UPDATE files_runtime_state SET state='syncing',last_error=NULL,updated_at=NOW() WHERE id=TRUE");
  }

  async markRootSyncing(rootId:string):Promise<void> {
    await this.db.query("UPDATE file_roots SET state='syncing',last_error=NULL,updated_at=NOW() WHERE id=$1", [rootId]);
  }

  async collection(collectionId:string):Promise<any> {
    return (await this.db.query('SELECT * FROM collections WHERE id=$1', [collectionId])).rows[0];
  }

  async upsertRemoteCollection(remote:any):Promise<void> {
    await this.db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy)
          VALUES($1,$2,$3,$4,$5,'synced',$6,$7,$8,$9)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,org_id=EXCLUDED.org_id,updated_at=NOW()`, [remote.id, remote.org_id, remote.owner_user_id, remote.name, remote.kind, remote.encryption, remote.encrypted_data_key, remote.dedup_key_ciphertext, remote.retention_policy ?? {}]);
  }

  async markSynced(rootIds:string[]):Promise<void> {
    await this.db.query("UPDATE files_runtime_state SET state='synced',pending_files=0,last_error=NULL,last_sync_at=NOW(),updated_at=NOW() WHERE id=TRUE");
    await this.db.query("UPDATE file_roots SET state='idle',pending_files=0,last_error=NULL,last_sync_at=NOW(),updated_at=NOW() WHERE id=ANY($1::text[])", [rootIds]);
  }

  async cursor(collectionId:string, deviceId:string):Promise<{ last_seq:string | number; last_push_seq:string | number }> {
    await this.db.query('INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [collectionId, deviceId]);
    return this.readCursor(collectionId, deviceId);
  }

  async readCursor(collectionId:string, deviceId:string):Promise<any> {
    return (await this.db.query('SELECT * FROM file_sync_cursors WHERE collection_id=$1 AND device_id=$2', [collectionId, deviceId])).rows[0];
  }

  async advancePull(collectionId:string, deviceId:string, seq:unknown):Promise<void> {
    await this.db.query('UPDATE file_sync_cursors SET last_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, deviceId, seq]);
  }

  async advancePush(collectionId:string, deviceId:string, seq:unknown):Promise<void> {
    await this.db.query('UPDATE file_sync_cursors SET last_push_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, deviceId, seq]);
  }

  /** Every local journal entry this device has not pushed yet (reviewed unbounded read: one legacy sync pass). */
  async unpushed(collectionId:string, afterSeq:unknown, deviceId:string):Promise<any[]> {
    return (await this.db.query(`SELECT j.seq,j.op,row_to_json((SELECT x FROM (SELECT f.id,f.collection_id,f.path,f.current_version_id,f.deleted_at,f.expires_at,f.created_by_type,f.created_by_id,f.mime,f.size,f.created_at,f.updated_at,f.extraction_status,f.draft_version_id,f.published_version_id,f.versioning_enabled,f.lifecycle_generation,f.operation_revision) x)) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM journal j JOIN files f ON f.id=j.file_id JOIN file_versions v ON v.id=j.version_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE j.collection_id=$1 AND j.seq>$2 AND v.device_id=$3 ORDER BY j.seq`, [collectionId, afterSeq, deviceId])).rows;
  }

  async chunks(collectionId:string, chunkIds:string[]):Promise<any[]> {
    return (await this.db.query('SELECT * FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, chunkIds])).rows;
  }

  async markServerBase(versionId:string):Promise<void> {
    await this.db.query('UPDATE file_versions SET base_server_version_id=id WHERE id=$1', [versionId]);
  }

  async recordConflictCopy(client:pg.PoolClient, item:any, input:{ fileId:string; versionId:string; collectionId:string; path:string; deviceId:string; contentHash:string; size:number; mtimeMs:number; rootId:string }):Promise<void> {
    await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.fileId, input.collectionId, input.path, item.file.created_by_type, item.file.created_by_id, item.file.mime, item.file.size]);
    await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,NULL,$4,$5,FALSE,$6,$7,$8,$9,NULL)`, [input.versionId, input.fileId, item.version.chunk_collection_id, item.version.manifest_hash, item.version.size, item.version.created_by_type, item.version.created_by_id, `Conflict copy of ${ item.file.path }`, input.deviceId]);
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [input.fileId, input.versionId]);
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [item.version.chunk_collection_id, item.manifest.chunk_ids]);
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'conflict')", [input.collectionId, input.fileId, input.versionId]);
    await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND path=$2', [input.collectionId, item.file.path]);
    await client.query('INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [input.collectionId, input.path, input.fileId, input.contentHash, input.size, Math.trunc(input.mtimeMs), input.rootId]);
  }
}
