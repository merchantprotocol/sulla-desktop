// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { RetryableDatabaseError, TransactionRunner } from '../FilesTransaction.js';
import { ChunkGcRepository } from '../Repositories/ChunkGcRepository.js';

import type pg from 'pg';

export type DeleteChunk = (collectionId:string, chunkId:string)=>Promise<void>;

/**
 * Drains the physical chunk GC queue. Each queued chunk is re-counted under a version-table
 * lock in its own short transaction; a chunk no version references is deleted from the store
 * and from `chunks`. A failure rolls back that chunk only and is recorded as last_error.
 */
export class ChunkGcDrainer {
  constructor(
    private readonly db:Pick<pg.Pool, 'query' | 'connect'>,
    private readonly gc = new ChunkGcRepository(db),
    private readonly transactions = new TransactionRunner(db),
  ) {}

  async drain(deleteChunk:DeleteChunk, maxBatches = 5):Promise<void> {
    for (let batch = 0; batch < maxBatches; batch++) {
      const pending = await this.gc.pendingBatch();
      if (!pending.rowCount) break;
      for (const item of pending.rows) {
        try {
          await this.transactions.run('chunk-gc', client => this.collect(client, item, deleteChunk));
        } catch (error:any) {
          // A lost connection used to escape from ROLLBACK and abort the drain; keep that.
          if (error instanceof RetryableDatabaseError) throw error;
          await this.gc.recordError(this.db, item.collection_id, item.chunk_id, String(error?.message ?? error).slice(0, 1000)).catch(() => undefined);
        }
      }
      if (pending.rows.length < 500) break;
    }
  }

  private async collect(client:pg.PoolClient, item:{ collection_id:string; chunk_id:string }, deleteChunk:DeleteChunk):Promise<void> {
    await this.gc.lockVersionsTable(client);
    const queued = await this.gc.lockQueued(client, item.collection_id, item.chunk_id);
    if (!queued) return;
    const refs = await this.gc.countReferences(client, item.collection_id, item.chunk_id);
    await this.gc.setRefcount(client, item.collection_id, item.chunk_id, refs);
    if (refs === 0) { await deleteChunk(item.collection_id, item.chunk_id); await this.gc.deleteChunkRow(client, item.collection_id, item.chunk_id) }
    await this.gc.dequeue(client, item.collection_id, item.chunk_id);
    if (queued.audit_id && !await this.gc.hasPendingForAudit(client, queued.audit_id)) await this.gc.markAuditChunkGc(client, queued.audit_id, 'complete');
  }
}
