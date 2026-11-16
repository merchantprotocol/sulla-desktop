// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import { DatabaseBatchReceiptView } from './DatabaseBatchReceiptView.js';
import { DatabaseBatchRequestParser } from './DatabaseBatchRequestParser.js';
import type { DatabaseBatchItem, DatabaseBatchReceipt, DatabaseBatchRequest, DatabaseCollisionPolicy, DatabaseItemError } from './DatabaseBatchTypes.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import type { DatabaseOperationService } from './DatabaseOperationService.js';
import type { DatabaseOperationAccess, DatabaseOperationRequest } from './DatabaseOperationTypes.js';
import type { DatabaseOperationUndoService } from './DatabaseOperationUndoService.js';
import type { FolderOperationService } from './FolderOperationService.js';
import type { FolderUndoService } from './FolderUndoService.js';
import { OperationFailure } from './OperationFailure.js';

const fail = (status:number, message:string, code='invalid-operation'):Error => OperationFailure.coded(status, message, code);

export interface DatabaseBatchExecutors {
  files:DatabaseOperationService;
  fileUndo:DatabaseOperationUndoService;
  folders:FolderOperationService;
  folderUndo:FolderUndoService;
}

/** Submits, runs and controls (cancel, retry, undo) receipt batches of file and folder items. */
export class DatabaseBatchService {
  constructor(
    private readonly context:DatabaseOperationContext,
    private readonly executors:DatabaseBatchExecutors,
    private readonly parser = new DatabaseBatchRequestParser(),
    private readonly receipts = new DatabaseBatchReceiptView(context),
  ) {}

  parse(value:any):DatabaseBatchRequest { return this.parser.parse(value) }

  async capabilities(collectionId:string, access:DatabaseOperationAccess):Promise<{
    enabled:boolean; reason?:string; folderReceipts:boolean; nativeFolderReceipts:boolean;
    folderCollisionPolicies:DatabaseCollisionPolicy[]; crossCollectionOperations:'all-authorized'|'stored-authorized'|'unavailable';
  }> {
    if (!OperationFailure.uuid.test(collectionId)) throw fail(400, 'collectionId must be a UUID');
    return this.context.transaction.run(async client => {
      // The caller authorizes collection visibility before invoking discovery.
      const native = await this.context.files.hasNativeRoot(client, collectionId);
      const helperAvailable = Boolean(access.custody && await access.custody.available());
      const enabled = !native || helperAvailable;
      return { enabled,...(!enabled?{reason:access.custody?'native-helper-unavailable':'native-custody-required'}:{}),folderReceipts:enabled,
        nativeFolderReceipts:Boolean(native && enabled),folderCollisionPolicies:['replace','keep-both','skip'],
        crossCollectionOperations:helperAvailable?'all-authorized':native?'unavailable':'stored-authorized' };
    });
  }

  async submit(input:DatabaseBatchRequest, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
    const scope = OperationFailure.scope(actor);
    await access.prepare?.(input.collectionId);
    for (const id of new Set(input.items.map(i=>i.targetCollectionId).filter((id):id is string=>Boolean(id)))) await access.prepare?.(id);
    return this.context.transaction.run(async client => {
      const { batches, locks, files } = this.context;
      await locks.lock(client, JSON.stringify([actor.userId, scope, input.idempotencyKey]));
      const prior = await batches.lockPrior(client, actor.userId, scope, input.idempotencyKey, input);
      if (prior) {
        if (!prior.same_request) throw fail(409, 'Idempotency key already used for another request', 'idempotency-conflict');
        await this.receipts.authorize(client, prior, access);
        return this.receipts.view(client, prior);
      }
      await this.receipts.authorize(client, { request: input, collection_id: input.collectionId }, access);
      const collections = [input.collectionId,...input.items.map(item=>item.targetCollectionId).filter((id):id is string=>Boolean(id))];
      const native = await files.anyNativeRoot(client, collections);
      if (!access.custody && native) throw fail(422, 'Native operations require the custody coordinator', 'native-custody-required');
      if (access.custody && native && !await access.custody.available()) throw fail(503,'Atomic native mutation helper is unavailable','native-helper-unavailable');
      const keys = Object.fromEntries(input.items.map(item => [item.itemId, randomUUID()]));
      const row = await batches.insert(client, actor.userId, scope, input.idempotencyKey, input.collectionId, input, keys);
      return this.receipts.view(client, row);
    });
  }

  async get(id:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
    await this.prepare(id, access);
    return this.context.transaction.run(async client => { const row = await this.receipts.owner(client, id, false); await this.receipts.authorize(client, row, access); return this.receipts.view(client, row) });
  }

  private async prepare(id:string, access:DatabaseOperationAccess):Promise<void> {
    if (!OperationFailure.uuid.test(id)) throw fail(400,'operationId must be a UUID');
    const row = await this.context.batches.header(this.context.db, id);
    if (!row) throw fail(404,'Operation not found');
    await access.prepare?.(row.collection_id);
    for (const item of row.request.items) if (item.targetCollectionId) await access.prepare?.(item.targetCollectionId);
  }

  private safeError(error:any):DatabaseItemError {
    const status = typeof error.status === 'number' ? error.status : 500;
    // Callers only see a generic retry message for unexpected failures, so keep the cause in the service log.
    if (status >= 500) console.error('[SullaFiles] database operation item failed:', error?.stack ?? error);
    return { status, code: typeof error.code === 'string' && !/^[0-9A-Z]{5}$/.test(error.code) ? error.code : status === 409 ? 'state-conflict' : 'operation-failed',
      message: status < 500 ? error.message : 'The item could not be committed; retry using the same operation.', ...(error.destination ? { destination: error.destination } : {}) };
  }

  /** Executes every pending item in order; each item commits (or fails) on its own. */
  async run(id:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<void> {
    const { transaction, batches } = this.context;
    const batch = await transaction.run(client => this.receipts.owner(client, id));
    for (const original of batch.request.items as DatabaseBatchItem[]) {
      let input:any;
      const guard = async(client:pg.PoolClient) => {
        const row = await this.receipts.owner(client, id);
        if (row.cancelled || row.errors[original.itemId]) throw fail(409, 'Item is not pending', 'item-not-pending');
        const receipts = await this.receipts.itemRows(client, row);
        if (receipts.some(r => r.idempotency_key === row.item_keys[original.itemId])) throw fail(409, 'Item already committed', 'item-not-pending');
        const effective = this.parser.item({ ...original, ...row.overrides[original.itemId] }, row.collection_id);
        input = { ...effective, collectionId: row.collection_id, idempotencyKey: row.item_keys[original.itemId],batchOperationId:id };
        // The execution snapshot must match the policies read before starting.
        if (JSON.stringify(input) !== JSON.stringify(planned)) throw fail(409, 'Retry policy changed', 'item-not-pending');
        await batches.touch(client, id);
      };
      const row = await transaction.run(client => this.receipts.owner(client, id));
      const planned = { ...this.parser.item({ ...original, ...row.overrides[original.itemId] }, row.collection_id), collectionId: row.collection_id, idempotencyKey: row.item_keys[original.itemId],batchOperationId:id };
      try {
        const execute = async() => {
          if (planned.kind==='folder') await this.executors.folders.execute(planned,actor,access,guard);
          else if (planned.action === 'create-folder') await this.executors.fileUndo.createFolder(planned as any, actor, access, guard);
          else await this.executors.files.execute(planned as DatabaseOperationRequest, actor, access, guard);
        };
        if (access.custody) await access.custody.run(execute); else await execute();
      } catch (error:any) {
        if (error.code === 'item-not-pending') continue;
        await transaction.run(async client => {
          const latest = await this.receipts.owner(client, id);
          // A lost COMMIT response must not turn durable success into failure.
          if ((await this.receipts.itemRows(client, latest)).some(r => r.idempotency_key === latest.item_keys[original.itemId]) && error.code!=='recovery-required') return;
          await batches.setItemError(client, id, original.itemId, this.safeError(error));
        });
      }
    }
  }

  async control(id:string, action:'cancel'|'retry'|'undo', body:any, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
    const { transaction, cancellation } = this.context;
    await this.prepare(id, access);
    if (action!=='retry') {
      await transaction.run(async client=>{const row=await this.receipts.owner(client,id,false);await this.receipts.authorize(client,row,access)});
      cancellation.request(id);
    } else if (access.custody) await access.custody.run(async()=>undefined);
    const result = await transaction.run(client => this.applyControl(client, id, action, body, access)).finally(()=>cancellation.clear(id));
    if (action === 'undo') {
      await this.undoCompleted(id, result, actor, access);
      return this.get(id, actor, access);
    }
    return result;
  }

  private async applyControl(client:pg.PoolClient, id:string, action:'cancel'|'retry'|'undo', body:any, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
    const row = await this.receipts.owner(client, id); await this.receipts.authorize(client, row, access);
    const receipt = await this.receipts.view(client, row);
    if (action === 'retry') {
      if (body?.items !== undefined && (!Array.isArray(body.items) || body.items.length > 250)) throw fail(400, 'retry items must be an array');
      const selected = body?.items ?? receipt.items.filter(i => i.retryable).map(i => ({ itemId: i.itemId }));
      if (new Set(selected.map((i:any) => i.itemId)).size !== selected.length) throw fail(400, 'Duplicate retry item');
      for (const update of selected) {
        const item = receipt.items.find(i => i.itemId === update.itemId);
        if (!item?.retryable) throw fail(409, 'Only pending, failed or cancelled items can be retried');
        const original = row.request.items.find((i:DatabaseBatchItem) => i.itemId === update.itemId);
        const override = { ...row.overrides[update.itemId], ...(update.collisionPolicy !== undefined ? { collisionPolicy: update.collisionPolicy, expectedDestination: update.expectedDestination } : {}) };
        this.parser.item({ ...original, ...override }, row.collection_id);
        row.overrides[update.itemId] = override; delete row.errors[update.itemId];
      }
      // Non-selected uncommitted items stay paused as durable errors.
      for (const item of receipt.items.filter(i => i.retryable && !selected.some((s:any) => s.itemId === i.itemId))) row.errors[item.itemId] ??= { status:409,code:'not-selected',message:'Not selected for retry' };
      row.cancelled = false;
    } else row.cancelled = true; // Undo first stops forward execution.
    const updated = await this.context.batches.saveControl(client, id, row.cancelled, row.errors, row.overrides);
    return this.receipts.view(client, updated);
  }

  /** Undoes completed items newest first; each item records its own failure and the rest continue. */
  private async undoCompleted(id:string, result:DatabaseBatchReceipt, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<void> {
    const { transaction, batches, receipts } = this.context;
    for (const item of [...result.items].reverse().filter(i => i.undoSupported)) {
      try {
        const guard = async(client:pg.PoolClient) => {
          const row = await this.receipts.owner(client,id);
          if (!row.cancelled) throw fail(409, 'Forward execution resumed; undo stopped');
        };
        const stored = await receipts.requestOf(this.context.db, item.receiptId!);
        const execute = async() => {
          if (stored?.request.kind==='folder') await this.executors.folderUndo.undo(item.receiptId!,actor,access,guard);
          else await this.executors.fileUndo.undo(item.receiptId!,actor,access,guard);
        };
        if (access.custody) await access.custody.run(execute); else await execute();
        await transaction.run(async client => { await this.receipts.owner(client,id); await batches.clearItemError(client, id, item.itemId) });
      } catch (error:any) {
        await transaction.run(async client => { await this.receipts.owner(client,id); await batches.setItemError(client, id, item.itemId, this.safeError(error)) });
      }
    }
  }
}
