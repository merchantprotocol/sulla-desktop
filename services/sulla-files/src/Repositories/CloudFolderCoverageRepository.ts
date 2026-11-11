// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { CloudFolderCoverageStore, FolderCoverageCounts } from '../cloudSync/folderCoverage.js';
import { lockStoredNamespace } from '../storedNamespace.js';
import type { PgCloudPushCandidateRepository } from './CloudPushCandidateRepository.js';

/**
 * Folder rows created before migration 057 never entered files_folder_journal, so the
 * uploader never saw them and their children reference folders Cloud does not hold.
 * Every live folder with no Cloud identity gets a `create` journal row for its CURRENT
 * namespace version. Purely additive: folder ids, paths and version ids are untouched.
 */
export class PgCloudFolderCoverageStore implements CloudFolderCoverageStore {
  constructor(
    private readonly db:pg.Pool,
    private readonly holds:Pick<PgCloudPushCandidateRepository, 'releaseCommittedHolds'>,
  ) {}

  async enabledCollectionIds():Promise<string[]> {
    return (await this.db.query("SELECT collection_id::text AS id FROM files_cloud_sync WHERE enabled=TRUE AND wrapped_root IS NOT NULL ORDER BY collection_id"))
      .rows.map(row => String(row.id));
  }

  async counts(collectionIds:string[]):Promise<Omit<FolderCoverageCounts, 'collections'>> {
    if (!collectionIds.length) return { liveFolders: 0, foldersMissingFromCloud: 0, childrenOfUncommittedParents: 0 };
    const row = (await this.db.query(`WITH live AS (
        SELECT ff.collection_id,ff.id,ff.path FROM file_folders ff WHERE ff.collection_id=ANY($1::uuid[]) AND ff.deleted_at IS NULL
      ), committed AS (
        SELECT l.collection_id,l.path FROM live l
        WHERE EXISTS(SELECT 1 FROM files_cloud_folder_versions cv WHERE cv.collection_id=l.collection_id AND cv.folder_id=l.id)
           OR EXISTS(SELECT 1 FROM files_cloud_folders cf WHERE cf.collection_id=l.collection_id AND cf.file_id=l.id)
        UNION SELECT cf.collection_id,cf.path FROM files_cloud_folders cf WHERE cf.collection_id=ANY($1::uuid[]) AND cf.deleted=FALSE AND cf.path IS NOT NULL
      ), children AS (
        SELECT f.collection_id,regexp_replace(f.path,'/[^/]+$','') AS parent_path FROM files f
          WHERE f.collection_id=ANY($1::uuid[]) AND f.deleted_at IS NULL AND strpos(f.path,'/')>0
        UNION ALL SELECT l.collection_id,regexp_replace(l.path,'/[^/]+$','') FROM live l WHERE strpos(l.path,'/')>0
      )
      SELECT (SELECT COUNT(*) FROM live) AS live_folders,
        (SELECT COUNT(*) FROM live l WHERE NOT EXISTS(SELECT 1 FROM files_cloud_folder_versions cv WHERE cv.collection_id=l.collection_id AND cv.folder_id=l.id)
          AND NOT EXISTS(SELECT 1 FROM files_cloud_folders cf WHERE cf.collection_id=l.collection_id AND cf.file_id=l.id)) AS missing,
        (SELECT COUNT(*) FROM children c WHERE NOT EXISTS(SELECT 1 FROM committed p WHERE p.collection_id=c.collection_id AND p.path=c.parent_path)) AS orphaned`,
    [collectionIds])).rows[0];
    return {
      liveFolders: Number(row?.live_folders ?? 0),
      foldersMissingFromCloud: Number(row?.missing ?? 0),
      childrenOfUncommittedParents: Number(row?.orphaned ?? 0),
    };
  }

  async journalMissingFolders(collectionId:string):Promise<number> {
    await this.holds.releaseCommittedHolds();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await lockStoredNamespace(client, collectionId);
      // Ordered subquery: shallower folders draw lower journal seqs, so parents queue first.
      const inserted = await client.query(`INSERT INTO files_folder_journal(seq,collection_id,folder_id,version_id,parent_version_id,path,deleted,op)
        SELECT nextval(pg_get_serial_sequence('journal','seq')),ordered.collection_id,ordered.id,ordered.namespace_version_id,NULL,ordered.path,FALSE,'create'
        FROM (
          SELECT ff.collection_id,ff.id,ff.namespace_version_id,ff.path FROM file_folders ff
          WHERE ff.collection_id=$1 AND ff.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM files_cloud_folder_versions cv WHERE cv.collection_id=ff.collection_id AND cv.folder_id=ff.id)
            AND NOT EXISTS(SELECT 1 FROM files_cloud_folders cf WHERE cf.collection_id=ff.collection_id AND cf.file_id=ff.id)
            AND NOT EXISTS(SELECT 1 FROM files_folder_journal fj WHERE fj.version_id=ff.namespace_version_id)
          ORDER BY cardinality(string_to_array(ff.path,'/')),ff.path
        ) ordered
        ON CONFLICT(version_id) DO NOTHING`, [collectionId]);
      await client.query('COMMIT');
      return inserted.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
