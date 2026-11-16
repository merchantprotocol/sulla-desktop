// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/**
 * SQL that applies replicated (pulled) journal entries: lifecycle state, remote deletes and new
 * versions. Every write runs on the caller's transaction client with sulla.trusted_replication set.
 */
export class ReplicationRepository {
  constructor(private readonly db:pg.Pool) {}

  async trustReplication(client:pg.PoolClient):Promise<void> {
    await client.query("SET LOCAL sulla.trusted_replication='on'");
  }

  async applyLifecycle(client:pg.PoolClient, entry:any, collectionId:string):Promise<void> {
    await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,lifecycle_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,-1) ON CONFLICT(id) DO NOTHING`, [entry.file.id, collectionId, entry.file.path,
        entry.file.created_by_type, entry.file.created_by_id, entry.file.mime, entry.file.size]);
    await client.query(`UPDATE files SET
        draft_version_id=CASE WHEN EXISTS(SELECT 1 FROM file_versions WHERE id=$2 AND file_id=$1) THEN $2 ELSE draft_version_id END,
        published_version_id=CASE WHEN EXISTS(SELECT 1 FROM file_versions WHERE id=$3 AND file_id=$1) THEN $3 ELSE published_version_id END,
        versioning_enabled=$4,major_minor_enabled=$5,require_approval=$6,require_checkout=$7,
        checked_out_by_user_id=$8,checked_out_by_device_id=$9,checked_out_at=$10,retention_mode=$11,retain_until=$12,
        retention_event_type=$13,retention_event_at=$14,retention_duration_days=$15,record_lock_type=$16,record_locked_at=$17,
        record_locked_by=$18,disposal_status=$19,disposal_review_at=$20,disposal_extended_until=$21,lifecycle_generation=$22,updated_at=NOW()
        WHERE id=$1 AND lifecycle_generation < $22`, [entry.file.id, entry.file.draft_version_id, entry.file.published_version_id, entry.file.versioning_enabled, entry.file.major_minor_enabled,
        entry.file.require_approval, entry.file.require_checkout, entry.file.checked_out_by_user_id, entry.file.checked_out_by_device_id, entry.file.checked_out_at,
        entry.file.retention_mode, entry.file.retain_until, entry.file.retention_event_type, entry.file.retention_event_at, entry.file.retention_duration_days,
        entry.file.record_lock_type, entry.file.record_locked_at, entry.file.record_locked_by, entry.file.disposal_status, entry.file.disposal_review_at,
        entry.file.disposal_extended_until, entry.file.lifecycle_generation]);
  }

  async filePath(fileId:string):Promise<{ path:string } | undefined> {
    return (await this.db.query('SELECT path FROM files WHERE id=$1', [fileId])).rows[0];
  }

  async applyDelete(client:pg.PoolClient, entry:any, collectionId:string):Promise<void> {
    await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id)
            VALUES($1,$2,$3,$4,NULL,0,TRUE,$5,$6,$7,$8,$9,$1) ON CONFLICT DO NOTHING`, [entry.version.id, entry.file.id, entry.version.chunk_collection_id, entry.version.parent_version_id, entry.version.created_by_type, entry.version.created_by_id, entry.version.created_at, entry.version.message, entry.version.device_id]);
    await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [entry.file.id, entry.version.id]);
    await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2', [collectionId, entry.file.id]);
  }

  async lockPrior(client:pg.PoolClient, fileId:string):Promise<{ path:string; current_version_id:string | null; record_lock_type:string; lifecycle_generation:string | number } | undefined> {
    return (await client.query('SELECT path,current_version_id,record_lock_type,lifecycle_generation FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  async insertManifest(client:pg.PoolClient, manifest:{ hash:string; chunk_ids:string[]; total_size:number }):Promise<void> {
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifest.hash, JSON.stringify(manifest.chunk_ids), manifest.total_size]);
  }

  async upsertFile(client:pg.PoolClient, entry:any, collectionId:string):Promise<void> {
    await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,versioning_enabled,major_minor_enabled,require_approval,require_checkout,
        checked_out_by_user_id,checked_out_by_device_id,checked_out_at,retention_mode,retain_until,retention_event_type,retention_event_at,retention_duration_days,
        record_lock_type,record_locked_at,record_locked_by,disposal_status,disposal_review_at,disposal_extended_until,lifecycle_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,mime=EXCLUDED.mime,size=EXCLUDED.size,deleted_at=NULL,
        versioning_enabled=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.versioning_enabled ELSE files.versioning_enabled END,
        major_minor_enabled=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.major_minor_enabled ELSE files.major_minor_enabled END,
        require_approval=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.require_approval ELSE files.require_approval END,
        require_checkout=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.require_checkout ELSE files.require_checkout END,
        checked_out_by_user_id=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.checked_out_by_user_id ELSE files.checked_out_by_user_id END,
        checked_out_by_device_id=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.checked_out_by_device_id ELSE files.checked_out_by_device_id END,
        checked_out_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.checked_out_at ELSE files.checked_out_at END,
        retention_mode=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_mode ELSE files.retention_mode END,
        retain_until=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retain_until ELSE files.retain_until END,
        retention_event_type=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_event_type ELSE files.retention_event_type END,
        retention_event_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_event_at ELSE files.retention_event_at END,
        retention_duration_days=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_duration_days ELSE files.retention_duration_days END,
        record_lock_type=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.record_lock_type ELSE files.record_lock_type END,
        record_locked_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.record_locked_at ELSE files.record_locked_at END,
        record_locked_by=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.record_locked_by ELSE files.record_locked_by END,
        disposal_status=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.disposal_status ELSE files.disposal_status END,
        disposal_review_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.disposal_review_at ELSE files.disposal_review_at END,
        disposal_extended_until=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.disposal_extended_until ELSE files.disposal_extended_until END,
        lifecycle_generation=GREATEST(files.lifecycle_generation,EXCLUDED.lifecycle_generation),updated_at=NOW()`,
    [entry.file.id, collectionId, entry.file.path, entry.file.created_by_type, entry.file.created_by_id, entry.file.mime, entry.file.size,
        entry.file.versioning_enabled ?? false, entry.file.major_minor_enabled ?? false, entry.file.require_approval ?? false, entry.file.require_checkout ?? false,
        entry.file.checked_out_by_user_id ?? null, entry.file.checked_out_by_device_id ?? null, entry.file.checked_out_at ?? null, entry.file.retention_mode ?? 'none', entry.file.retain_until ?? null,
        entry.file.retention_event_type ?? null, entry.file.retention_event_at ?? null, entry.file.retention_duration_days ?? null, entry.file.record_lock_type ?? 'none',
        entry.file.record_locked_at ?? null, entry.file.record_locked_by ?? null, entry.file.disposal_status ?? 'none', entry.file.disposal_review_at ?? null,
        entry.file.disposal_extended_until ?? null, entry.file.lifecycle_generation ?? 0]);
  }

  /** Insert or refresh the replicated version; true only when this call inserted the row. */
  async upsertVersion(client:pg.PoolClient, entry:any, replicatedLifecycle:{ publication_status?:string | null; published_at?:unknown; published_by?:unknown }):Promise<boolean> {
    const result = await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id,
        major_version,minor_version,version_kind,publication_status,published_at,published_by,version_comment)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$1,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(id) DO UPDATE SET
        major_version=EXCLUDED.major_version,minor_version=EXCLUDED.minor_version,version_kind=EXCLUDED.version_kind,
        publication_status=EXCLUDED.publication_status,published_at=EXCLUDED.published_at,published_by=EXCLUDED.published_by,
        version_comment=EXCLUDED.version_comment,base_server_version_id=EXCLUDED.id
        RETURNING (xmax = 0) AS inserted`,
    [entry.version.id, entry.file.id, entry.version.chunk_collection_id, entry.version.parent_version_id, entry.version.manifest_hash, entry.version.size,
        entry.version.deleted, entry.version.created_by_type, entry.version.created_by_id, entry.version.created_at, entry.version.message, entry.version.device_id,
        entry.version.major_version ?? 0, entry.version.minor_version ?? 1, entry.version.version_kind ?? 'minor', replicatedLifecycle.publication_status ?? 'draft',
        replicatedLifecycle.published_at ?? null, replicatedLifecycle.published_by ?? null, entry.version.version_comment ?? null]);
    return Boolean(result.rows[0]?.inserted);
  }

  async activateVersion(client:pg.PoolClient, fileId:string, versionId:string, publicationStatus:string):Promise<void> {
    await client.query(`UPDATE files SET current_version_id=$2,
        draft_version_id=CASE WHEN $3='draft' THEN $2 ELSE draft_version_id END,
        published_version_id=CASE WHEN $3='published' THEN $2 WHEN $3='draft' AND published_version_id=$2 THEN NULL ELSE published_version_id END WHERE id=$1`, [fileId, versionId, publicationStatus]);
  }

  async upsertWatchedState(client:pg.PoolClient, input:{ collectionId:string; path:string; fileId:string; contentHash:string; size:number; mtimeMs:number; rootId:string }):Promise<void> {
    await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`, [input.collectionId, input.path, input.fileId, input.contentHash, input.size, Math.trunc(input.mtimeMs), input.rootId]);
  }
}
