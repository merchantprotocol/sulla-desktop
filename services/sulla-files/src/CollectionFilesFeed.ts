// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { CollectionFilesFeedRepository, type FeedQueryable } from './Repositories/CollectionFilesFeedRepository.js';

export type { FeedQueryable } from './Repositories/CollectionFilesFeedRepository.js';

export interface RecentFilesInput { collectionId:string; limit:unknown; createdByType?:unknown }

export interface CollectionFileStats {
  fileCount:number;
  totalBytes:number;
  agentRunCount:number;
  indexing:{ total:number; pending:number; indexing:number; indexed:number; partial:number; unsupported:number; failed:number; complete:boolean };
}

/**
 * Cross-folder views of one collection that must not depend on which folder the client has open:
 * the bounded "Recent" / "Agent files" lists and the collection-wide counts behind badges and storage figures.
 * Validation and shaping live here; the SQL lives in CollectionFilesFeedRepository.
 */
export class CollectionFilesFeed {
  static readonly defaultLimit = 50;
  static readonly maxLimit = 200;
  static readonly createdByTypes = new Set(['user', 'agent', 'agent-run']);

  constructor(db:FeedQueryable, fileColumnsSql:string, private readonly repository = new CollectionFilesFeedRepository(db, fileColumnsSql)) {}

  static parseLimit(value:unknown):number {
    const requested = Number(value ?? CollectionFilesFeed.defaultLimit);
    return Number.isSafeInteger(requested) ? Math.min(CollectionFilesFeed.maxLimit, Math.max(1, requested)) : CollectionFilesFeed.defaultLimit;
  }

  /** Active files ordered newest-first by updated_at (ties by id), never more than maxLimit rows. */
  async recent(input:RecentFilesInput):Promise<any[]> {
    let createdByType:string | undefined;
    if (typeof input.createdByType === 'string' && input.createdByType) {
      if (!CollectionFilesFeed.createdByTypes.has(input.createdByType)) throw new RangeError('invalid createdByType');
      createdByType = input.createdByType;
    }
    return this.repository.recent(input.collectionId, CollectionFilesFeed.parseLimit(input.limit), createdByType);
  }

  /**
   * Recursive totals for each direct child folder of `path` (''= root), so folder rows show their real file count
   * and size even though the client only loads the open folder's own files. One grouped range scan of the subtree.
   */
  async folderSummaries(collectionId:string, path:string):Promise<{ name:string; fileCount:number; totalBytes:number; updatedAt:string|null }[]> {
    const rows = await this.repository.folderSummaries(collectionId, path ? `${ path }/` : '');
    return rows.map(row => ({ name: String(row.name), fileCount: Number(row.file_count), totalBytes: Number(row.total_bytes), updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null }));
  }

  /** Collection-wide totals computed by the server, never from whichever rows a client happens to have loaded. */
  async stats(collectionId:string):Promise<CollectionFileStats> {
    const row = await this.repository.stats(collectionId);
    const count = (key:string) => Number(row[key] ?? 0);
    const indexing = { total: count('file_count'), pending: count('pending'), indexing: count('indexing'), indexed: count('indexed'), partial: count('partial'), unsupported: count('unsupported'), failed: count('failed'), complete: false };
    indexing.complete = indexing.pending === 0 && indexing.indexing === 0 && indexing.partial === 0 && indexing.unsupported === 0 && indexing.failed === 0;
    return { fileCount: count('file_count'), totalBytes: count('total_bytes'), agentRunCount: count('agent_run_count'), indexing };
  }
}
