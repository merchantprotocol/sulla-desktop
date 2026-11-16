// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Agent-run file reads, file edges and run-end scratch expiry. */
export class AgentFileRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly fileColumnsSql:string) {}

  /** How many of these runs' files still sit in an unpublished legacy external collection. */
  async legacyRunFileCount(userId:string, runIds:string[], orgId:string | null):Promise<number> {
    const legacy = await this.db.query(`SELECT count(*)::int AS count FROM files f JOIN collections c ON c.id=f.collection_id
        JOIN file_versions v ON v.id=f.current_version_id JOIN collections chunks ON chunks.id=v.chunk_collection_id
        WHERE c.owner_user_id=$1 AND ($3::text IS NULL OR c.org_id=$3::text) AND ((c.compatibility_state='legacy-external-data' AND NOT EXISTS(SELECT 1 FROM files_legacy_collection_map m WHERE m.source_collection_id=c.id AND m.published_at IS NOT NULL))
          OR (chunks.compatibility_state='legacy-external-data' AND NOT EXISTS(SELECT 1 FROM files_legacy_collection_map m WHERE m.source_collection_id=chunks.id AND m.published_at IS NOT NULL)))
          AND (c.agent_run_id=ANY($2::text[]) OR f.created_by_type='agent-run' AND f.created_by_id=ANY($2::text[]))`, [userId, runIds, orgId]);
    return Number(legacy.rows[0]?.count ?? 0);
  }

  /** The runs' live native files visible to this thread, newest first (runIds is capped at 100 by the caller). */
  async runFiles(userId:string, runIds:string[], threadId:string, orgId:string | null):Promise<any[]> {
    return (await this.db.query(`SELECT ${ this.fileColumnsSql },c.kind AS collection_kind,c.agent_run_id
        FROM files f JOIN collections c ON c.id=f.collection_id JOIN file_versions v ON v.id=f.current_version_id JOIN collections chunks ON chunks.id=v.chunk_collection_id
        WHERE c.owner_user_id=$1 AND ($4::text IS NULL OR c.org_id=$4::text) AND c.compatibility_state='native' AND c.published=TRUE AND c.legacy_source=FALSE
          AND chunks.compatibility_state='native' AND chunks.published=TRUE AND chunks.legacy_source=FALSE AND (c.thread_id=$3 OR c.thread_id IS NULL)
          AND (c.agent_run_id=ANY($2::text[]) OR (f.created_by_type='agent-run' AND f.created_by_id=ANY($2::text[])))
          AND f.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
        ORDER BY f.updated_at DESC`, [userId, runIds, threadId, orgId])).rows;
  }

  /** The user's home collection for Use Case drafts: manage-granted first, then default, then oldest. */
  async homeCollectionId(userId:string):Promise<string | undefined> {
    return (await this.db.query("SELECT id FROM collections WHERE owner_user_id=$1 AND system_area IS NULL AND published=TRUE AND legacy_source=FALSE ORDER BY EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=collections.id AND a.principal_type='user' AND a.principal_id=$1 AND a.role='manage') DESC,is_default DESC,created_at LIMIT 1", [userId])).rows[0]?.id;
  }

  /** A non-deleted version of this file. */
  async liveVersion(versionId:string, fileId:string):Promise<any | undefined> {
    return (await this.db.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted', [versionId, fileId])).rows[0];
  }

  async link(fileId:string, targetFileId:string, kind:string, createdBy:string):Promise<void> {
    await this.db.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,$3,$4) ON CONFLICT DO NOTHING`, [fileId, targetFileId, kind, createdBy]);
  }

  /** Gives the run's live scratch files a 14-day TTL; returns how many were scheduled. */
  async expireRunScratch(userId:string, jobId:string | undefined, orgId:string | null):Promise<number> {
    const result = await this.db.query(`UPDATE files f SET expires_at=NOW()+INTERVAL '14 days',updated_at=NOW()
      FROM collections c WHERE f.collection_id=c.id AND c.owner_user_id=$1 AND c.agent_run_id=$2 AND ($3::text IS NULL OR c.org_id=$3::text) AND c.kind='scratch' AND c.published=TRUE AND c.legacy_source=FALSE AND f.expires_at IS NULL AND f.deleted_at IS NULL RETURNING f.id`, [userId, jobId, orgId]);
    return result.rowCount ?? result.rows.length;
  }
}
