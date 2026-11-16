// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface FeedQueryable {
  query(text:string, values?:unknown[]):Promise<{ rows:any[] }>;
}

export interface FolderSummaryRow { name:unknown; file_count:unknown; total_bytes:unknown; updated_at:unknown }

const METADATA_NAME = '_folder-metadata.yaml';

/**
 * SQL for the collection-wide feed views (Recent / Agent files, child-folder totals, collection stats).
 * Every read hides deleted, unversioned, protected and `_folder-metadata.yaml` rows.
 */
export class CollectionFilesFeedRepository {
  constructor(private readonly db:FeedQueryable, private readonly fileColumnsSql:string) {}

  /** Newest-first active files; `limit` and `createdByType` must already be validated by the caller. */
  async recent(collectionId:string, limit:number, createdByType?:string):Promise<any[]> {
    const values:unknown[] = [collectionId];
    const clauses = [
      'f.collection_id=$1',
      'f.deleted_at IS NULL',
      'f.current_version_id IS NOT NULL',
      'NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)',
      `f.path<>'${ METADATA_NAME }'`,
      `right(f.path,${ METADATA_NAME.length + 1 })<>'/${ METADATA_NAME }'`,
    ];
    if (createdByType) { values.push(createdByType); clauses.push(`f.created_by_type=$${ values.length }`) }
    values.push(limit);
    const result = await this.db.query(`SELECT ${ this.fileColumnsSql },v.created_at AS version_created_at,v.created_by_type AS version_created_by_type,v.created_by_id AS version_created_by_id
      FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id
      WHERE ${ clauses.join(' AND ') } ORDER BY f.updated_at DESC,f.id DESC LIMIT $${ values.length }`, values);
    return result.rows;
  }

  /**
   * One grouped range scan of the subtree under `prefix` ('' = root). Reviewed bounded-by-design
   * (UnboundedReadGuard ALLOWED): it returns one aggregate row per direct child folder, never a row per file.
   */
  async folderSummaries(collectionId:string, prefix:string):Promise<FolderSummaryRow[]> {
    return (await this.db.query(`SELECT split_part(substr(f.path,length($2)+1),'/',1) AS name,COUNT(*)::bigint AS file_count,COALESCE(SUM(f.size),0)::bigint AS total_bytes,MAX(f.updated_at) AS updated_at
      FROM files f WHERE f.collection_id=$1 AND starts_with(f.path,$2) AND position('/' in substr(f.path,length($2)+1))>0
        AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
        AND right(f.path,${ METADATA_NAME.length + 1 })<>'/${ METADATA_NAME }'
      GROUP BY 1 ORDER BY 1`, [collectionId, prefix])).rows;
  }

  /** One aggregate row of collection-wide counts (empty object when Postgres returns no row). */
  async stats(collectionId:string):Promise<Record<string, unknown>> {
    return (await this.db.query(`SELECT COUNT(*)::bigint AS file_count,COALESCE(SUM(f.size),0)::bigint AS total_bytes,
        COUNT(DISTINCT f.created_by_id) FILTER (WHERE f.created_by_type='agent-run')::bigint AS agent_run_count,
        COUNT(*) FILTER (WHERE f.extraction_status='pending')::bigint AS pending,
        COUNT(*) FILTER (WHERE f.extraction_status='indexing')::bigint AS indexing,
        COUNT(*) FILTER (WHERE f.extraction_status='indexed')::bigint AS indexed,
        COUNT(*) FILTER (WHERE f.extraction_status='indexed' AND f.extraction_reason_code LIKE '%\\_partial')::bigint AS partial,
        COUNT(*) FILTER (WHERE f.extraction_status='unsupported')::bigint AS unsupported,
        COUNT(*) FILTER (WHERE f.extraction_status='failed')::bigint AS failed
      FROM files f WHERE f.collection_id=$1 AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
        AND f.path<>'${ METADATA_NAME }' AND right(f.path,${ METADATA_NAME.length + 1 })<>'/${ METADATA_NAME }'`, [collectionId])).rows[0] ?? {};
  }
}
