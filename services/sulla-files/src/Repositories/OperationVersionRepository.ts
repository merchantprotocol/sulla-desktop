// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** file_versions, chunk refcount and copied-file rows written by receipt operations. */
export class OperationVersionRepository {
  /** Appends the Trash tombstone version on top of the current head. */
  async insertTrashTombstone(client:Queryable, file:any, actor:FilesIdentity):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
  }

  async insertUndoCopyTombstone(client:Queryable, file:any, actor:FilesIdentity):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id)
        VALUES($1,$2,$3,0,TRUE,'user',$4,'Undo copy',$5) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
  }

  /** The live parent of the exact tombstone, locked for share (id only). */
  async lockTrashParentId(client:Queryable, parentId:string, tombstoneId:string, fileId:string):Promise<{ id:string } | undefined> {
    return (await client.query(`SELECT v.id FROM file_versions v JOIN file_versions tombstone ON tombstone.id=$2 AND tombstone.file_id=v.file_id
        WHERE v.id=$1 AND v.file_id=$3 AND v.deleted=FALSE AND tombstone.deleted=TRUE AND tombstone.parent_version_id=v.id FOR SHARE OF v,tombstone`,
    [parentId, tombstoneId, fileId])).rows[0];
  }

  /** The live parent of the exact tombstone, locked for share (full row). */
  async lockTrashParent(client:Queryable, parentId:string, tombstoneId:string, fileId:string):Promise<any> {
    return (await client.query(`SELECT v.* FROM file_versions v JOIN file_versions tombstone ON tombstone.id=$2 AND tombstone.file_id=v.file_id
    WHERE v.id=$1 AND v.file_id=$3 AND v.deleted=FALSE AND tombstone.deleted=TRUE AND tombstone.parent_version_id=v.id FOR SHARE OF v,tombstone`,
    [parentId, tombstoneId, fileId])).rows[0];
  }

  async lockVersion(client:Queryable, id:string, fileId:string):Promise<any> {
    return (await client.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 FOR UPDATE', [id, fileId])).rows[0];
  }

  /**
   * Follows the locked tombstone lineage to the first live version with content. It never
   * selects an unrelated newer draft/version by timestamp; UNION also terminates malformed cycles.
   */
  async lockRestorableAncestor(client:Queryable, start:string, fileId:string):Promise<any> {
    return (await client.query(`WITH RECURSIVE lineage AS (
      SELECT id,parent_version_id,deleted FROM file_versions WHERE id=$1 AND file_id=$2
      UNION SELECT v.id,v.parent_version_id,v.deleted FROM file_versions v JOIN lineage p ON v.id=p.parent_version_id
      WHERE p.deleted=TRUE AND v.file_id=$2)
      SELECT v.* FROM file_versions v JOIN lineage l ON l.id=v.id WHERE v.deleted=FALSE AND v.manifest_hash IS NOT NULL
      FOR UPDATE OF v`, [start, fileId])).rows[0];
  }

  /** Appends a "Restored from Trash" version that reuses the source manifest. */
  async insertRestoredVersion(client:Queryable, file:any, source:any, actor:FilesIdentity):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,restored_from_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
    VALUES($1,$2,$3,$4,$5,$6,'user',$7,'Restored from Trash',$8,$3) RETURNING id`,
    [file.id, source.chunk_collection_id, file.current_version_id, source.id, source.manifest_hash, source.size, actor.userId, actor.deviceId || 'server-web'])).rows[0];
  }

  async referenceManifestChunks(client:Queryable, collectionId:string, manifestHash:string):Promise<void> {
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id IN (SELECT jsonb_array_elements_text(chunk_ids) FROM manifests WHERE hash=$2)', [collectionId, manifestHash]);
  }

  async insertCopiedFile(client:Queryable, source:any, target:string, actor:FilesIdentity, destinationCollection:string):Promise<any> {
    return (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,expires_at,
    versioning_enabled,major_minor_enabled,require_approval)
    VALUES($1,$2,'user',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [destinationCollection, target, actor.userId, source.mime, source.size, source.expires_at, source.versioning_enabled, source.major_minor_enabled, source.require_approval])).rows[0];
  }

  async lockCopySource(client:Queryable, id:string, fileId:string):Promise<any> {
    return (await client.query(`SELECT v.*,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.file_id=$2 AND v.deleted=FALSE FOR SHARE OF v,m`, [id, fileId])).rows[0];
  }

  async insertCopiedVersion(client:Queryable, fileId:string, version:any, actor:FilesIdentity):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,publication_status,version_kind)
      VALUES($1,$2,$3,$4,'user',$5,'Copied document',$6,$7,$8) RETURNING id`,
    [fileId, version.chunk_collection_id, version.manifest_hash, version.size, actor.userId, actor.deviceId || 'server-web', version.publication_status, version.version_kind])).rows[0];
  }

  async referenceChunks(client:Queryable, collectionId:string, chunkIds:unknown):Promise<void> {
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, chunkIds]);
  }

  async copyKeyContexts(client:Queryable, fromVersionId:string, toVersionId:string):Promise<void> {
    await client.query(`INSERT INTO file_version_key_contexts(version_id,collection_id,principal_id,key_version,key_epoch)
      SELECT $2,collection_id,principal_id,key_version,key_epoch FROM file_version_key_contexts WHERE version_id=$1`, [fromVersionId, toVersionId]);
  }

  async copyFileShares(client:Queryable, fromFileId:string, toFileId:string, actor:FilesIdentity):Promise<void> {
    await client.query(`INSERT INTO file_shares(file_id,principal_type,principal_id,role,created_by)
    SELECT $2,principal_type,principal_id,role,$3 FROM file_shares WHERE file_id=$1`, [fromFileId, toFileId, actor.userId]);
  }

  /** Points the copy at its current version and carries checkout, retention and disposal state. */
  async finishCopy(client:Queryable, copiedId:string, currentVersionId:string, source:any, actor:FilesIdentity):Promise<any> {
    return (await client.query(`UPDATE files SET current_version_id=$2,require_checkout=$3,
    retention_mode=$4,retain_until=$5,retention_event_type=$6,retention_event_at=$7,retention_duration_days=$8,
    disposal_status=$9,disposal_review_at=$10,disposal_extended_until=$11,
    checked_out_by_user_id=CASE WHEN $3 THEN $12 ELSE NULL END,
    checked_out_by_device_id=CASE WHEN $3 THEN $13 ELSE NULL END,
    checked_out_at=CASE WHEN $3 THEN NOW() ELSE NULL END WHERE id=$1 RETURNING *`,
    [copiedId, currentVersionId, source.require_checkout, source.retention_mode, source.retain_until, source.retention_event_type,
      source.retention_event_at, source.retention_duration_days, source.disposal_status, source.disposal_review_at, source.disposal_extended_until, actor.userId, actor.deviceId || 'server-web'])).rows[0];
  }
}
