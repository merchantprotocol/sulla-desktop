// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/**
 * Document lifecycle state on files / file_versions / files_publish_requests: versioning
 * settings, checkout, publication, retention, record locks and disposal. Transactional
 * methods take the transaction's client; reads outside a transaction use the pool.
 */
export class DocumentLifecycleRepository {
  constructor(private readonly db:Queryable) {}

  async lockFile(client:Queryable, id:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  async journal(client:Queryable, collectionId:string, fileId:string, versionId:string, op:'lifecycle' | 'put'):Promise<void> {
    await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [collectionId, fileId, versionId, op]);
  }

  /** Journals a lifecycle change against the file's current (or published, or explicit) version. */
  async journalFile(client:Queryable, file:any, op:'lifecycle' | 'put' = 'lifecycle', explicitVersionId?:string):Promise<void> {
    const versionId = explicitVersionId ?? file.current_version_id ?? file.published_version_id;
    if (versionId) await this.journal(client, file.collection_id, file.id, versionId, op);
  }

  async retentionActive(client:Queryable, fileId:string):Promise<boolean | undefined> {
    return (await client.query('SELECT files_retention_active(f) active FROM files f WHERE id=$1', [fileId])).rows[0]?.active;
  }

  async liveVersionId(versionId:string, fileId:string):Promise<string | undefined> {
    return (await this.db.query('SELECT id FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=FALSE', [versionId, fileId])).rows[0]?.id;
  }

  async updateSettings(client:Queryable, fileId:string, enabled:boolean | null, majorMinor:boolean | null, requireApproval:boolean | null, requireCheckout:boolean | null):Promise<any> {
    return (await client.query(`UPDATE files SET
        versioning_enabled=COALESCE($2,versioning_enabled),major_minor_enabled=COALESCE($3,major_minor_enabled),
        require_approval=COALESCE($4,require_approval),require_checkout=COALESCE($5,require_checkout),
        lifecycle_generation=lifecycle_generation+1,updated_at=NOW() WHERE id=$1 RETURNING *`,
    [fileId, enabled, majorMinor, requireApproval, requireCheckout])).rows[0];
  }

  async checkout(client:Queryable, fileId:string, userId:string, deviceId:string):Promise<any> {
    return (await client.query(`UPDATE files SET checked_out_by_user_id=$2,checked_out_by_device_id=$3,checked_out_at=COALESCE(checked_out_at,NOW()),lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [fileId, userId, deviceId])).rows[0];
  }

  async releaseCheckout(client:Queryable, fileId:string):Promise<any> {
    return (await client.query(`UPDATE files SET checked_out_by_user_id=NULL,checked_out_by_device_id=NULL,checked_out_at=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [fileId])).rows[0];
  }

  async lockVersion(client:Queryable, versionId:string, fileId:string):Promise<any> {
    return (await client.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=FALSE FOR UPDATE', [versionId, fileId])).rows[0];
  }

  async maxMajor(client:Queryable, fileId:string):Promise<number> {
    return Number((await client.query('SELECT COALESCE(MAX(major_version),0)::int n FROM file_versions WHERE file_id=$1', [fileId])).rows[0].n);
  }

  async maxMinor(client:Queryable, fileId:string, major:number):Promise<number> {
    return Number((await client.query('SELECT COALESCE(MAX(minor_version),0)::int n FROM file_versions WHERE file_id=$1 AND major_version=$2', [fileId, major])).rows[0].n);
  }

  async supersedePublished(client:Queryable, fileId:string):Promise<void> {
    await client.query("UPDATE file_versions SET publication_status='superseded' WHERE file_id=$1 AND publication_status='published'", [fileId]);
  }

  async markVersionPublished(client:Queryable, versionId:string, major:number, userId:string, comment:string | null):Promise<void> {
    await client.query(`UPDATE file_versions SET publication_status='published',version_kind='major',major_version=$2,minor_version=0,published_at=NOW(),published_by=$3,version_comment=COALESCE($4,version_comment) WHERE id=$1`, [versionId, major, userId, comment]);
  }

  async markFilePublished(client:Queryable, fileId:string, versionId:string, releaseCheckout:boolean):Promise<any> {
    return (await client.query(`UPDATE files SET published_version_id=$2,draft_version_id=CASE WHEN draft_version_id=$2 THEN NULL ELSE draft_version_id END,
      checked_out_by_user_id=CASE WHEN $3 THEN NULL ELSE checked_out_by_user_id END,checked_out_by_device_id=CASE WHEN $3 THEN NULL ELSE checked_out_by_device_id END,checked_out_at=CASE WHEN $3 THEN NULL ELSE checked_out_at END,
      lifecycle_generation=lifecycle_generation+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [fileId, versionId, releaseCheckout])).rows[0];
  }

  /** One keyset page (newest first) of a file's live versions; pass limit+1 to detect more. */
  async listVersions(fileId:string, cursor:{ createdAt:string; id:string } | undefined, limit:number):Promise<any[]> {
    return (await this.db.query(`SELECT id,major_version,minor_version,version_kind,publication_status,created_by_type,created_by_id,created_at,version_comment,size
      FROM file_versions WHERE file_id=$1 AND deleted=FALSE
        AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`, [fileId,cursor?.createdAt ?? null,cursor?.id ?? null,limit])).rows;
  }

  async findDraftVersion(client:Queryable, versionId:string, fileId:string):Promise<any> {
    return (await client.query("SELECT id FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=FALSE AND (publication_status IS NULL OR publication_status='draft')", [versionId,fileId])).rows[0];
  }

  async upsertPublishRequest(client:Queryable, fileId:string, versionId:string, requestedBy:string, reason:string | null):Promise<any> {
    return (await client.query(`INSERT INTO files_publish_requests(file_id,version_id,requested_by,reason) VALUES($1,$2,$3,$4)
        ON CONFLICT(file_id,version_id) WHERE status='pending' DO UPDATE SET reason=COALESCE(EXCLUDED.reason,files_publish_requests.reason) RETURNING *`,
    [fileId,versionId,requestedBy,reason])).rows[0];
  }

  async listPublishRequests(status:string, fileId:string | null):Promise<any[]> {
    return (await this.db.query(`SELECT r.*,f.path,f.collection_id FROM files_publish_requests r JOIN files f ON f.id=r.file_id
      WHERE r.status=$1 AND ($2::uuid IS NULL OR r.file_id=$2) ORDER BY r.created_at`, [status,fileId])).rows;
  }

  async lockPublishRequest(client:Queryable, requestId:string):Promise<any> {
    return (await client.query('SELECT * FROM files_publish_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
  }

  async decidePublishRequest(client:Queryable, requestId:string, status:'approved' | 'rejected', userId:string):Promise<any> {
    return (await client.query(`UPDATE files_publish_requests SET status=$2,decided_by=$3,decided_at=NOW() WHERE id=$1 RETURNING *`, [requestId,status,userId])).rows[0];
  }

  /** Numbers a draft version on check-in; returns false when no such draft exists. */
  async checkinVersion(client:Queryable, versionId:string, fileId:string, comment:string | null, kind:'major' | 'minor', major:number, minor:number):Promise<boolean> {
    const result = await client.query(`UPDATE file_versions SET version_comment=COALESCE($3,version_comment),version_kind=$4,major_version=$5,minor_version=$6 WHERE id=$1 AND file_id=$2 AND (publication_status IS NULL OR publication_status='draft') RETURNING id`, [versionId, fileId, comment, kind, major, minor]);
    return Boolean(result.rowCount);
  }

  async updateRetention(client:Queryable, fileId:string, mode:string, retainUntil:Date | null, eventType:string | null, eventAt:Date | null, days:number | null):Promise<any> {
    return (await client.query(`UPDATE files SET retention_mode=$2,retain_until=$3,retention_event_type=$4,retention_event_at=$5,retention_duration_days=$6,disposal_status='none',disposal_review_at=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [fileId, mode, retainUntil, eventType, eventAt, days])).rows[0];
  }

  async setRecordLock(client:Queryable, fileId:string, kind:string, userId:string):Promise<any> {
    return (await client.query(`UPDATE files SET record_lock_type=$2,record_locked_at=COALESCE(record_locked_at,NOW()),record_locked_by=COALESCE(record_locked_by,$3),lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [fileId, kind, userId])).rows[0];
  }

  async clearRecordLock(client:Queryable, fileId:string):Promise<any> {
    return (await client.query(`UPDATE files SET record_lock_type='none',record_locked_at=NULL,record_locked_by=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [fileId])).rows[0];
  }

  async reviewDisposal(client:Queryable, fileId:string, status:string, extendedUntil:Date | null):Promise<any> {
    return (await client.query(`UPDATE files SET disposal_status=$2,disposal_review_at=NOW(),disposal_extended_until=$3,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [fileId, status, extendedUntil])).rows[0];
  }

  /** Replaces the whole lifecycle state with a newer generation from another device. */
  async applyLifecycleState(client:Queryable, values:unknown[]):Promise<any> {
    return (await client.query(`UPDATE files SET versioning_enabled=$2,major_minor_enabled=$3,require_approval=$4,require_checkout=$5,
        checked_out_by_user_id=$6,checked_out_by_device_id=$7,checked_out_at=$8,retention_mode=$9,retain_until=$10,retention_event_type=$11,
        retention_event_at=$12,retention_duration_days=$13,record_lock_type=$14,record_locked_at=$15,record_locked_by=$16,
        disposal_status=$17,disposal_review_at=$18,disposal_extended_until=$19,lifecycle_generation=$20,updated_at=NOW() WHERE id=$1 RETURNING *`,
    values)).rows[0];
  }
}
