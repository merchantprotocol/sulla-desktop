// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { PushOrderingStore } from '../cloudSync/pushOrdering.js';
import type { PushCandidate } from '../cloudSync/repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Upload candidate selection for Cloud sync: what to push next, folder parents and held versions. */
export class PgCloudPushCandidateRepository implements PushOrderingStore {
  constructor(private readonly db:pg.Pool) {}

  /**
   * The earliest current file or folder namespace version unknown to Cloud. A version held
   * in files_cloud_namespace_holds is skipped until its retry time, then offered again even
   * if the cursor has moved past it. Callers must gate parents through CloudPushOrdering.
   */
  async nextPushCandidate(collectionId:string, cursor:number):Promise<PushCandidate | null> {
    const row = (await this.db.query(`SELECT * FROM (
      SELECT j.op,j.seq,f.id::text AS file_id,f.path,f.mime,v.id::text AS version_id,v.parent_version_id::text AS parent_version_id,
        v.deleted,v.chunk_collection_id::text AS chunk_collection_id,v.size,v.created_at,m.chunk_ids,w.mtime_ms,v.restored_from_version_id,
        regexp_replace(f.path,'^.*/','') AS item_name,
        CASE WHEN strpos(f.path,'/')=0 THEN NULL ELSE COALESCE((SELECT ff.id::text FROM file_folders ff WHERE ff.collection_id=f.collection_id AND ff.path=regexp_replace(f.path,'/[^/]+$','') AND ff.deleted_at IS NULL LIMIT 1),
          (SELECT cf.file_id::text FROM files_cloud_folders cf WHERE cf.collection_id=f.collection_id AND cf.path=regexp_replace(f.path,'/[^/]+$','') AND cf.deleted=FALSE LIMIT 1)) END AS parent_folder_id,
        'file'::text AS item_kind
      FROM journal j
      JOIN files f ON f.id=j.file_id AND f.current_version_id=j.version_id
      JOIN file_versions v ON v.id=j.version_id
      LEFT JOIN manifests m ON m.hash=v.manifest_hash
      LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
      LEFT JOIN files_cloud_skips k ON k.version_id=v.id
      LEFT JOIN files_cloud_namespace_holds h ON h.version_id=v.id
      WHERE j.collection_id=$1 AND (j.seq>$2 OR k.retry_at<=NOW() OR h.retry_at<=NOW()) AND (k.version_id IS NULL OR k.retry_at<=NOW())
        AND (h.version_id IS NULL OR h.retry_at<=NOW())
        AND NOT EXISTS(SELECT 1 FROM files_cloud_versions cv WHERE cv.version_id=v.id)
      UNION ALL
      SELECT fj.op,fj.seq,fj.folder_id::text,fj.path,''::text,fj.version_id::text,fj.parent_version_id::text,
        fj.deleted,fj.collection_id::text,0,fj.at,NULL,NULL,fj.restored_from_version_id,regexp_replace(fj.path,'^.*/',''),
        ${ PgCloudPushCandidateRepository.folderParentSql('fj') }, 'folder'::text
      FROM files_folder_journal fj
      JOIN file_folders f ON f.id=fj.folder_id AND f.namespace_version_id=fj.version_id
      LEFT JOIN files_cloud_namespace_holds h ON h.version_id=fj.version_id
      WHERE fj.collection_id=$1 AND (fj.seq>$2 OR h.retry_at<=NOW()) AND (h.version_id IS NULL OR h.retry_at<=NOW())
        AND NOT EXISTS(SELECT 1 FROM files_cloud_folder_versions cv WHERE cv.version_id=fj.version_id)
    ) candidates ORDER BY seq LIMIT 1`, [collectionId, cursor])).rows[0];
    return row ? this.pushCandidate(row) : null;
  }

  /** A folder's parent identity: the live local folder at the parent path, else the Cloud identity known there. */
  private static folderParentSql(alias:string):string {
    return `CASE WHEN strpos(${ alias }.path,'/')=0 THEN NULL ELSE COALESCE((SELECT parent.id::text FROM file_folders parent WHERE parent.collection_id=${ alias }.collection_id
          AND parent.path=regexp_replace(${ alias }.path,'/[^/]+$','') AND parent.deleted_at IS NULL LIMIT 1),
          (SELECT cf.file_id::text FROM files_cloud_folders cf WHERE cf.collection_id=${ alias }.collection_id AND cf.path=regexp_replace(${ alias }.path,'/[^/]+$','') AND cf.deleted=FALSE LIMIT 1)) END`;
  }

  private pushCandidate(row:any):PushCandidate {
    const mtime = row.mtime_ms !== null && row.mtime_ms !== undefined ? new Date(Number(row.mtime_ms)) : new Date(row.created_at);
    const folder = row.item_kind === 'folder';
    return {
      journalSeq:Number(row.seq), fileId:row.file_id, path:row.path, mime:row.mime, versionId:row.version_id,
      parentVersionId:row.parent_version_id ?? null, deleted:Boolean(row.deleted), chunkCollectionId:row.chunk_collection_id,
      chunkIds:folder || row.deleted ? [] : (row.chunk_ids ?? []), size:folder || row.deleted ? 0 : Number(row.size), mtime:mtime.toISOString(),
      namespace:{ kind:folder ? 'folder' : 'file', name:String(row.item_name), parentFolderId:row.parent_folder_id ?? null,
        restoredFromVersionId:row.restored_from_version_id ?? undefined, operation:row.deleted ? 'delete' : row.op === 'rename' || row.op === 'metadata' ? 'metadata' : row.op === 'restore' ? 'restore' : row.parent_version_id ? 'content' : 'create' },
    };
  }

  async isFolderCommitted(collectionId:string, folderId:string):Promise<boolean> {
    if (!UUID.test(folderId)) return false;
    return Boolean((await this.db.query(`SELECT 1 FROM files_cloud_folder_versions WHERE collection_id=$1 AND folder_id=$2
      UNION ALL SELECT 1 FROM files_cloud_folders WHERE collection_id=$1 AND file_id=$2 LIMIT 1`, [collectionId, folderId])).rowCount);
  }

  /**
   * The live folder's current namespace version as a push candidate. A folder that predates
   * the folder journal gets one additive `create` row for its existing version id.
   */
  async folderCandidate(collectionId:string, folderId:string):Promise<PushCandidate | null> {
    if (!UUID.test(folderId)) return null;
    await this.db.query(`INSERT INTO files_folder_journal(collection_id,folder_id,version_id,parent_version_id,path,deleted,op)
      SELECT ff.collection_id,ff.id,ff.namespace_version_id,NULL,ff.path,FALSE,'create' FROM file_folders ff
      WHERE ff.collection_id=$1 AND ff.id=$2 AND ff.deleted_at IS NULL
      ON CONFLICT(version_id) DO NOTHING`, [collectionId, folderId]);
    const row = (await this.db.query(`SELECT fj.op,fj.seq,fj.folder_id::text AS file_id,fj.path,''::text AS mime,fj.version_id::text AS version_id,
        fj.parent_version_id::text AS parent_version_id,fj.deleted,fj.collection_id::text AS chunk_collection_id,0 AS size,fj.at AS created_at,
        NULL AS chunk_ids,NULL AS mtime_ms,fj.restored_from_version_id,regexp_replace(fj.path,'^.*/','') AS item_name,
        ${ PgCloudPushCandidateRepository.folderParentSql('fj') } AS parent_folder_id,'folder'::text AS item_kind
      FROM file_folders ff JOIN files_folder_journal fj ON fj.version_id=ff.namespace_version_id AND fj.folder_id=ff.id
      WHERE ff.collection_id=$1 AND ff.id=$2 AND ff.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM files_cloud_folder_versions cv WHERE cv.version_id=fj.version_id)
      ORDER BY fj.seq DESC LIMIT 1`, [collectionId, folderId])).rows[0];
    return row ? this.pushCandidate(row) : null;
  }

  /** Retries back off from 5 minutes to 6 hours; a parent arriving by pull or upload releases it on the next try. */
  async hold(collectionId:string, candidate:PushCandidate, reason:string):Promise<void> {
    await this.db.query(`INSERT INTO files_cloud_namespace_holds(version_id,collection_id,item_id,kind,reason,retry_at)
      VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '5 minutes')
      ON CONFLICT(version_id) DO UPDATE SET reason=EXCLUDED.reason,attempts=files_cloud_namespace_holds.attempts+1,
        retry_at=NOW()+LEAST(INTERVAL '6 hours', INTERVAL '5 minutes'*POWER(2,files_cloud_namespace_holds.attempts))`,
    [candidate.versionId, collectionId, candidate.fileId, candidate.namespace?.kind ?? 'file', reason.slice(0, 100)]);
  }

  /** Holds whose version Cloud has since committed are finished; drop them. */
  async releaseCommittedHolds():Promise<number> {
    const result = await this.db.query(`DELETE FROM files_cloud_namespace_holds h
      WHERE EXISTS(SELECT 1 FROM files_cloud_versions cv WHERE cv.version_id=h.version_id)
         OR EXISTS(SELECT 1 FROM files_cloud_folder_versions fv WHERE fv.version_id=h.version_id)`);
    return result.rowCount ?? 0;
  }
}
