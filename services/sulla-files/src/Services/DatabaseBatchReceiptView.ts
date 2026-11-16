// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { DatabaseBatchItem, DatabaseBatchItemReceipt, DatabaseBatchReceipt, DatabaseBatchRequest, DatabaseBatchState, DatabaseItemError,
  DatabaseItemState } from './DatabaseBatchTypes.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import type { DatabaseOperationAccess } from './DatabaseOperationTypes.js';
import { OperationFailure } from './OperationFailure.js';

/** Loads, authorizes and renders one batch with its item receipts and native recovery state. */
export class DatabaseBatchReceiptView {
  constructor(private readonly context:DatabaseOperationContext) {}

  async owner(client:pg.PoolClient, id:string, lock = true):Promise<any> {
    if (!OperationFailure.uuid.test(id)) throw OperationFailure.coded(400, 'operationId must be a UUID', 'invalid-operation');
    const row = await this.context.batches.find(client, id, lock);
    if (!row) throw OperationFailure.coded(404, 'Operation not found', 'invalid-operation');
    return row;
  }

  /** Re-checks access to every source, destination and committed/conflicting state the batch exposes. */
  async authorize(client:pg.PoolClient, row:any, access:DatabaseOperationAccess):Promise<void> {
    for (const item of (row.request as DatabaseBatchRequest).items) {
      if (item.fileId) await access.file(client, item.fileId);
      else await access.path(client, row.collection_id, item.folderPath ?? item.targetPath!);
      if (item.targetPath) await access.path(client,item.targetCollectionId ?? row.collection_id,item.targetPath);
    }
    if (row.item_keys) {
      const receipts = await this.context.receipts.destinationsByKeys(client, row.actor_user_id, row.actor_scope, Object.values(row.item_keys));
      for (const receipt of receipts) {
        for (const state of [receipt.after_state,receipt.displaced_after]) {
          if (state?.fileId) await access.file(client,state.fileId);
          else if (state?.folderId) await access.path(client,state.collectionId??row.collection_id,state.path);
        }
      }
      for (const [itemId,error] of Object.entries(row.errors) as [string,DatabaseItemError][]) {
        const destination = error.destination;
        if (!destination) continue;
        if ('fileId' in destination) await access.file(client,destination.fileId);
        else {
          const item = (row.request as DatabaseBatchRequest).items.find(candidate=>candidate.itemId===itemId);
          await access.path(client,item?.targetCollectionId ?? row.collection_id,destination.path);
        }
      }
    }
  }

  itemRows(client:pg.PoolClient, row:any):Promise<any[]> {
    return this.context.receipts.byKeys(client, Object.values(row.item_keys));
  }

  async view(client:pg.PoolClient, row:any):Promise<DatabaseBatchReceipt> {
    const receipts = await this.itemRows(client, row);
    const native = await this.context.batches.nativeRows(client, row.id);
    const items:DatabaseBatchItemReceipt[] = row.request.items.map((item:DatabaseBatchItem) => {
      const stored = receipts.find(r => r.idempotency_key === row.item_keys[item.itemId]);
      const nativeRow = native.find(n=>n.item_id===item.itemId);
      const pending = nativeRow && (!['completed','undone','rolled-back'].includes(nativeRow.state)||nativeRow.last_error) ? nativeRow : null;
      const error = pending ? {status:409,code:'recovery-required',message:'Native artifacts require reconciliation before retry or undo'} : row.errors[item.itemId] ?? null;
      const state:DatabaseItemState = stored?.state ?? (error?.code==='recovery-required'?'failed':row.cancelled ? 'cancelled' : error ? 'failed' : 'pending');
      const invalidated = Boolean(stored?.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt || nativeRow?.plan?.disposal?.undoInvalidatedAt);
      return { itemId: item.itemId, action: item.action, state, receiptId: stored?.id ?? null,
        before: stored?.before_state ?? null, after: stored?.after_state ?? null,
        ...(stored?.displaced_before ? { displacedBefore: stored.displaced_before, displacedAfter: stored.displaced_after } : {}),
        error, undoSupported: state === 'completed' && !invalidated, retryable: ['pending','failed','cancelled'].includes(state) };
    });
    const state:DatabaseBatchState = items.some(i=>i.error?.code==='recovery-required')?(items.some(i=>i.state==='completed' || i.state==='undone')?'partial':'failed'):items.some(i => i.state === 'pending') ? 'pending'
      : items.every(i => i.state === 'undone' || i.state === 'skipped') && items.some(i => i.state === 'undone') ? 'undone'
        : items.every(i => i.state === 'completed' || i.state === 'skipped') ? (items.some(i => i.error) ? 'partial' : 'completed')
          : items.some(i => i.state === 'completed' || i.state === 'undone') ? 'partial' : items.some(i=>i.error?.code==='recovery-required')?'failed':row.cancelled ? 'cancelled' : 'failed';
    return { operationId: row.id, collectionId: row.collection_id, state, cancelRequested: row.cancelled,
      undoSupported: items.some(i => i.undoSupported), retryable: items.some(i => i.retryable),
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), items };
  }
}
