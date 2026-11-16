// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export type ShareQueryable = Pick<pg.Pool, 'query'>;

/**
 * Every statement on file_share_links / file_share_events, plus the reads that resolve a
 * share to its file. Each method takes the queryable it runs on (the pool by default, or
 * the link-locked client) so callers keep the exact connection the old inline SQL used.
 */
export class ShareLinkRepository {
  constructor(private readonly db:ShareQueryable) {}

  /** Session advisory lock serialising every mutation of one link across processes. */
  async acquireLinkLock(client:ShareQueryable, id:string):Promise<void> {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [id]);
  }

  async releaseLinkLock(client:ShareQueryable, id:string):Promise<void> {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id]);
  }

  /** Disables local access and records (or clears) the durable remote-delete intent. */
  async persistRemoteDeleteState(id:string, pending:boolean, queryable:ShareQueryable = this.db):Promise<void> {
    await queryable.query(`UPDATE file_share_links SET revoked_at=COALESCE(revoked_at,NOW()),keep_available=FALSE,keep_until=NULL,
      reconciliation_required=$2,reconciliation_action=CASE WHEN $2 THEN 'delete' ELSE NULL END,reconciliation_updated_at=CASE WHEN $2 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1`, [id, pending]);
  }

  async pendingDeleteIds(ownerUserId:string):Promise<Array<{ id:string }>> {
    return (await this.db.query(`SELECT id FROM file_share_links WHERE owner_user_id=$1 AND reconciliation_required=TRUE
      AND reconciliation_action='delete' ORDER BY reconciliation_updated_at LIMIT 25`, [ownerUserId])).rows;
  }

  async reconciliationState(client:ShareQueryable, id:string, ownerUserId:string):Promise<any> {
    return (await client.query(`SELECT owner_user_id,reconciliation_required,reconciliation_action FROM file_share_links
          WHERE id=$1 AND owner_user_id=$2`, [id, ownerUserId])).rows[0];
  }

  async findShareableFile(fileId:string):Promise<any> {
    return (await this.db.query('SELECT id,collection_id,path,mime FROM files WHERE id=$1 AND deleted_at IS NULL AND current_version_id IS NOT NULL', [fileId])).rows[0];
  }

  /** Inserts a link that starts revoked with a durable delete intent (see SharesService.create). */
  async insertPendingLink(client:ShareQueryable, values:unknown[]):Promise<void> {
    await client.query(`INSERT INTO file_share_links
        (id,owner_user_id,target_type,file_id,collection_id,folder_path,display_name,mime,access_mode,password_protected,password_hash,expires_at,keep_available,keep_until,display_sharer_name,served_from,device_id,relay_secret,asset_kind,capture_metadata,revoked_at,reconciliation_required,reconciliation_action,reconciliation_updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL,$18,$19,NOW(),TRUE,'delete',NOW())`, values);
  }

  async recordEvent(queryable:ShareQueryable, id:string, action:string, detail:string | null = null):Promise<void> {
    await queryable.query('INSERT INTO file_share_events(share_id,action,detail) VALUES($1,$2,$3)', [id, action, detail]);
  }

  async markRegistered(client:ShareQueryable, id:string, publicUrl:unknown, servedFrom:string):Promise<void> {
    await client.query(`UPDATE file_share_links SET public_url=$2,cloud_registered_at=NOW(),served_from=$3,revoked_at=NULL,
          reconciliation_required=FALSE,reconciliation_action=NULL,reconciliation_updated_at=NULL,updated_at=NOW() WHERE id=$1`, [id, publicUrl, servedFrom]);
  }

  async delete(client:ShareQueryable, id:string):Promise<void> {
    await client.query('DELETE FROM file_share_links WHERE id=$1', [id]);
  }

  async listOwned(ownerUserId:string):Promise<any[]> {
    return (await this.db.query('SELECT * FROM file_share_links WHERE owner_user_id=$1 ORDER BY created_at DESC', [ownerUserId])).rows;
  }

  async findOwned(queryable:ShareQueryable, id:string, ownerUserId:string):Promise<any> {
    return (await queryable.query('SELECT * FROM file_share_links WHERE id=$1 AND owner_user_id=$2', [id, ownerUserId])).rows[0];
  }

  /** Disables local access and persists cleanup intent before a policy update reaches Cloud. */
  async markUpdatePending(client:ShareQueryable, id:string):Promise<void> {
    await client.query(`UPDATE file_share_links SET revoked_at=COALESCE(revoked_at,NOW()),reconciliation_required=TRUE,
        reconciliation_action='delete',reconciliation_updated_at=NOW(),updated_at=NOW() WHERE id=$1`, [id]);
  }

  async applyPolicy(client:ShareQueryable, values:unknown[]):Promise<void> {
    await client.query(`UPDATE file_share_links SET access_mode=$2,password_protected=$3,password_hash=$4,expires_at=$5,keep_available=$6,keep_until=$7,display_sharer_name=$8,served_from=$9,revoked_at=NULL,reconciliation_required=FALSE,reconciliation_action=NULL,reconciliation_updated_at=NULL,updated_at=NOW() WHERE id=$1`, values);
  }

  async markRestored(client:ShareQueryable, id:string, publicUrl:unknown):Promise<void> {
    await client.query('UPDATE file_share_links SET revoked_at=NULL,public_url=$2,served_from=$3,reconciliation_required=FALSE,reconciliation_action=NULL,reconciliation_updated_at=NULL,updated_at=NOW() WHERE id=$1', [id, publicUrl, 'desktop']);
  }

  async activity(ownerUserId:string, id?:string):Promise<any[]> {
    const params:any[] = [ownerUserId]; const filter = id ? ' AND l.id=$2' : ''; if (id) params.push(id);
    return (await this.db.query(`SELECT e.id,e.action,e.detail,e.occurred_at FROM file_share_events e JOIN file_share_links l ON l.id=e.share_id WHERE l.owner_user_id=$1${ filter } ORDER BY e.occurred_at DESC LIMIT 500`, params)).rows;
  }

  async findById(id:string):Promise<any> {
    return (await this.db.query('SELECT * FROM file_share_links WHERE id=$1', [id])).rows[0];
  }

  async recordView(id:string):Promise<void> {
    await this.db.query('UPDATE file_share_links SET view_count=view_count+1,last_viewed_at=NOW(),updated_at=NOW() WHERE id=$1', [id]);
  }

  /** A link that is not revoked and not expired. */
  async findActive(id:string):Promise<any> {
    return (await this.db.query(`SELECT * FROM file_share_links WHERE id=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>NOW())`, [id])).rows[0];
  }

  /** Like findActive, but a link still awaiting its first verified publication is readable when allowed. */
  async findReadable(queryable:ShareQueryable, id:string, allowPendingPublication:boolean):Promise<any> {
    return (await queryable.query(`SELECT * FROM file_share_links WHERE id=$1
      AND (revoked_at IS NULL OR ($2=TRUE AND reconciliation_required=TRUE AND reconciliation_action='delete'))
      AND (expires_at IS NULL OR expires_at>NOW())`, [id, allowPendingPublication])).rows[0];
  }

  /** Every live, unprotected file under an escaped LIKE prefix (a shared folder's listing). */
  async folderFiles(queryable:ShareQueryable, collectionId:string, likePattern:string):Promise<any[]> {
    return (await queryable.query("SELECT path,mime,size FROM files WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=files.id) AND collection_id=$1 AND deleted_at IS NULL AND current_version_id IS NOT NULL AND path LIKE $2 ESCAPE E'\\\\' ORDER BY path", [collectionId, likePattern])).rows;
  }

  async findLiveFile(queryable:ShareQueryable, fileId:string):Promise<any> {
    return (await queryable.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [fileId])).rows[0];
  }

  async findLiveFileAt(queryable:ShareQueryable, collectionId:string, path:string):Promise<any> {
    return (await queryable.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [collectionId, path])).rows[0];
  }

  async readableVersion(queryable:ShareQueryable, versionId:string):Promise<any> {
    return (await queryable.query(`SELECT v.chunk_collection_id,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.deleted=FALSE`, [versionId])).rows[0];
  }
}
