// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface FeedQueryable {
  query(text:string, values?:unknown[]):Promise<{ rows:any[] }>;
}

export interface RecentFilesInput { collectionId:string; limit:unknown; createdByType?:unknown }

export interface CollectionFileStats {
  fileCount:number;
  totalBytes:number;
  agentRunCount:number;
  indexing:{ total:number; pending:number; indexing:number; indexed:number; partial:number; unsupported:number; failed:number; complete:boolean };
}

const METADATA_NAME = '_folder-metadata.yaml';

/**
 * Cross-folder views of one collection that must not depend on which folder the client has open:
 * the bounded "Recent" / "Agent files" lists and the collection-wide counts behind badges and storage figures.
 */
export class CollectionFilesFeed {
  static readonly defaultLimit = 50;
  static readonly maxLimit = 200;
  static readonly createdByTypes = new Set(['user', 'agent', 'agent-run']);

  constructor(private readonly db:FeedQueryable, private readonly fileColumnsSql:string) {}

  static parseLimit(value:unknown):number {
    const requested = Number(value ?? CollectionFilesFeed.defaultLimit);
    return Number.isSafeInteger(requested) ? Math.min(CollectionFilesFeed.maxLimit, Math.max(1, requested)) : CollectionFilesFeed.defaultLimit;
  }

  /** Active files ordered newest-first by updated_at (ties by id), never more than maxLimit rows. */
  async recent(input:RecentFilesInput):Promise<any[]> {
    const values:unknown[] = [input.collectionId];
    const clauses = [
      'f.collection_id=$1',
      'f.deleted_at IS NULL',
      'f.current_version_id IS NOT NULL',
      'NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)',
      `f.path<>'${ METADATA_NAME }'`,
      `right(f.path,${ METADATA_NAME.length + 1 })<>'/${ METADATA_NAME }'`,
    ];
    if (typeof input.createdByType === 'string' && input.createdByType) {
      if (!CollectionFilesFeed.createdByTypes.has(input.createdByType)) throw new RangeError('invalid createdByType');
      values.push(input.createdByType); clauses.push(`f.created_by_type=$${ values.length }`);
    }
    values.push(CollectionFilesFeed.parseLimit(input.limit));
    const result = await this.db.query(`SELECT ${ this.fileColumnsSql },v.created_at AS version_created_at,v.created_by_type AS version_created_by_type,v.created_by_id AS version_created_by_id
      FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id
      WHERE ${ clauses.join(' AND ') } ORDER BY f.updated_at DESC,f.id DESC LIMIT $${ values.length }`, values);
    return result.rows;
  }

  /**
   * Recursive totals for each direct child folder of `path` (''= root), so folder rows show their real file count
   * and size even though the client only loads the open folder's own files. One grouped range scan of the subtree.
   */
  async folderSummaries(collectionId:string, path:string):Promise<{ name:string; fileCount:number; totalBytes:number; updatedAt:string|null }[]> {
    const prefix = path ? `${ path }/` : '';
    const rows = (await this.db.query(`SELECT split_part(substr(f.path,length($2)+1),'/',1) AS name,COUNT(*)::bigint AS file_count,COALESCE(SUM(f.size),0)::bigint AS total_bytes,MAX(f.updated_at) AS updated_at
      FROM files f WHERE f.collection_id=$1 AND starts_with(f.path,$2) AND position('/' in substr(f.path,length($2)+1))>0
        AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
        AND right(f.path,${ METADATA_NAME.length + 1 })<>'/${ METADATA_NAME }'
      GROUP BY 1 ORDER BY 1`, [collectionId, prefix])).rows;
    return rows.map(row => ({ name: String(row.name), fileCount: Number(row.file_count), totalBytes: Number(row.total_bytes), updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null }));
  }

  /** Collection-wide totals computed by the server, never from whichever rows a client happens to have loaded. */
  async stats(collectionId:string):Promise<CollectionFileStats> {
    const row = (await this.db.query(`SELECT COUNT(*)::bigint AS file_count,COALESCE(SUM(f.size),0)::bigint AS total_bytes,
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
    const count = (key:string) => Number(row[key] ?? 0);
    const indexing = { total: count('file_count'), pending: count('pending'), indexing: count('indexing'), indexed: count('indexed'), partial: count('partial'), unsupported: count('unsupported'), failed: count('failed'), complete: false };
    indexing.complete = indexing.pending === 0 && indexing.indexing === 0 && indexing.partial === 0 && indexing.unsupported === 0 && indexing.failed === 0;
    return { fileCount: count('file_count'), totalBytes: count('total_bytes'), agentRunCount: count('agent_run_count'), indexing };
  }
}
