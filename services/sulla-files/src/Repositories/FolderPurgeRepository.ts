// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Permanent disposal of a trashed folder's metadata, purge tombstones and chunk GC queue. */
export class FolderPurgeRepository {
  async anyRetentionActive(client:Queryable, fileIds:string[]):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM files f WHERE f.id=ANY($1::uuid[]) AND files_retention_active(f) LIMIT 1', [fileIds])).rowCount);
  }

  async lockPathOperation(client:Queryable, operationId:string):Promise<any> {
    return (await client.query('SELECT * FROM files_path_operations WHERE operation_id=$1 FOR UPDATE', [operationId])).rows[0];
  }

  async savePathOperationPlan(client:Queryable, operationId:string, plan:unknown):Promise<void> {
    await client.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1', [operationId, plan]);
  }

  /** Blocks concurrent version writers while chunk references are recounted. */
  async lockVersions(client:Queryable):Promise<void> {
    await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
  }

  async chunksOf(client:Queryable, fileIds:string[]):Promise<{ chunk_collection_id:string; chunk_id:string }[]> {
    return (await client.query(`SELECT DISTINCT v.chunk_collection_id,jsonb_array_elements_text(m.chunk_ids) chunk_id FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.file_id=ANY($1::uuid[])`, [fileIds])).rows;
  }

  /** Keeps a purge tombstone with the audience that could see the file, so clients can forget it. */
  async recordPurgeTombstone(client:Queryable, collectionId:string, file:any):Promise<void> {
    await client.query(`INSERT INTO file_purge_tombstones(collection_id,file_id,path,lifecycle_generation,audience)
        SELECT $1,$2,$3,$4,jsonb_build_object(
          'users',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT owner_user_id principal FROM collections WHERE id=$1
            UNION SELECT principal_id FROM collection_acl WHERE collection_id=$1 AND principal_type='user'
            UNION SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='user' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='user') users)),
          'groups',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT principal_id principal FROM collection_acl WHERE collection_id=$1 AND principal_type='group'
            UNION SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='group' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='group') groups)))
        ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,lifecycle_generation=GREATEST(file_purge_tombstones.lifecycle_generation,EXCLUDED.lifecycle_generation),audience=EXCLUDED.audience,purged_at=NOW()`,
    [collectionId, file.id, file.path, Number(file.lifecycle_generation) + 1]);
  }

  /** Deletes the files' journal, links and rows; audit rows stay but lose their file references. */
  async purgeFiles(client:Queryable, fileIds:string[]):Promise<void> {
    await client.query('DELETE FROM journal WHERE file_id=ANY($1::uuid[])', [fileIds]);
    await client.query('UPDATE audit_log SET file_id=NULL,version_id=NULL WHERE file_id=ANY($1::uuid[]) OR version_id IN(SELECT id FROM file_versions WHERE file_id=ANY($1::uuid[]))', [fileIds]);
    await client.query('DELETE FROM file_share_links WHERE file_id=ANY($1::uuid[])', [fileIds]);
    await client.query('UPDATE files SET current_version_id=NULL,draft_version_id=NULL,published_version_id=NULL WHERE id=ANY($1::uuid[])', [fileIds]);
    await client.query('DELETE FROM files WHERE id=ANY($1::uuid[])', [fileIds]);
  }

  async chunkReferences(client:Queryable, collectionId:string, chunkId:string):Promise<number> {
    return Number((await client.query(`SELECT COUNT(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [collectionId, chunkId])).rows[0].refs);
  }

  async setChunkRefcount(client:Queryable, collectionId:string, chunkId:string, refs:number):Promise<void> {
    await client.query('UPDATE chunks SET refcount=$3 WHERE collection_id=$1 AND id=$2', [collectionId, chunkId, refs]);
  }

  async queueChunkGc(client:Queryable, collectionId:string, chunkId:string, auditId:string):Promise<void> {
    await client.query(`INSERT INTO file_chunk_gc(collection_id,chunk_id,audit_id) VALUES($1,$2,$3) ON CONFLICT(collection_id,chunk_id) DO UPDATE SET audit_id=EXCLUDED.audit_id,requested_at=NOW(),last_error=NULL`, [collectionId, chunkId, auditId]);
  }

  async chunkGcPending(db:Queryable, auditId:string):Promise<boolean> {
    return Boolean((await db.query('SELECT 1 FROM file_chunk_gc WHERE audit_id=$1 LIMIT 1', [auditId])).rowCount);
  }
}
