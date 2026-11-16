// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SyntheticFilesStore } from './SyntheticFilesStore';
import type { SyntheticMutationJournal } from './SyntheticMutationJournal';
import type { SyntheticOperationExecutor } from './SyntheticOperationExecutor';
import { SyntheticValues } from './SyntheticValues';
import type { SyntheticOperation } from './SyntheticFilesTypes';
import type { FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry } from '../types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

/** Durable-operation receipts for the preview: idempotent submit, item-by-item progress on a timer, cancel, retry and undo. */
export class SyntheticOperationService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly store:SyntheticFilesStore, private readonly executor:SyntheticOperationExecutor, private readonly journal:SyntheticMutationJournal) {}

  /** Re-arms the timers for receipts that were still pending when the session was saved. */
  resumePending():void {
    Object.values(this.store.state.operations).filter(value => value.receipt.state === 'pending').forEach(value => this.schedule(value.receipt.operationId));
  }

  async submitOperation(request:FilesOperationRequest):Promise<FilesOperationReceipt> {
    const immutable = SyntheticValues.clone(request); const fingerprint = JSON.stringify(immutable); const known = this.store.state.idempotency[request.idempotencyKey];

    if (known) {
      if (known.fingerprint !== fingerprint) throw new Error('Idempotency key was already submitted with a different synthetic request');
      return this.getOperation(known.operationId);
    }
    if (!request.idempotencyKey || !request.collectionId || !request.items.length || request.items.length > 250 || new Set(request.items.map(item => item.itemId)).size !== request.items.length) throw new Error('Synthetic operation request is invalid');
    this.store.collection(request.collectionId);
    const createdAt = new Date().toISOString(); const operationId = crypto.randomUUID();
    const receipt:FilesOperationReceipt = {
      operationId, collectionId: request.collectionId, state: 'pending', cancelRequested: false, undoSupported: false, retryable: false, createdAt, updatedAt: createdAt,
      items: request.items.map(item => ({ itemId: item.itemId, action: item.action, state: 'pending', receiptId: null, before: null, after: null, error: null, undoSupported: false, retryable: false })),
    };

    this.store.state.operations[operationId] = { request: immutable, fingerprint, receipt, mutations: {}, retryOverrides: {} };
    this.store.state.idempotency[request.idempotencyKey] = { fingerprint, operationId };
    this.store.persist(); this.schedule(operationId);
    return SyntheticValues.clone(receipt);
  }
  async getOperation(operationId:string):Promise<FilesOperationReceipt> { return SyntheticValues.clone(this.operation(operationId).receipt) }
  async cancelOperation(operationId:string):Promise<FilesOperationReceipt> {
    const operation = this.operation(operationId);

    if (operation.receipt.state === 'pending') { operation.receipt.cancelRequested = true; operation.receipt.updatedAt = new Date().toISOString(); this.store.persist(); this.schedule(operationId, 0) }
    return SyntheticValues.clone(operation.receipt);
  }
  async retryOperation(operationId:string, retry:FilesOperationRetry = {}):Promise<FilesOperationReceipt> {
    const operation = this.operation(operationId); const ids = retry.items?.map(item => item.itemId) ?? operation.receipt.items.filter(item => item.state === 'failed' || item.state === 'cancelled').map(item => item.itemId);

    if (operation.receipt.state === 'pending') throw new Error('Wait for the synthetic operation to finish before retrying it');
    if (new Set(ids).size !== ids.length) throw new Error('A synthetic item can only be retried once per request');
    const validated = ids.map(id => {
      const receipt = operation.receipt.items.find(item => item.itemId === id); const override = retry.items?.find(item => item.itemId === id);

      if (!receipt || !receipt.retryable || !['failed', 'cancelled'].includes(receipt.state)) throw new Error('Only retryable failed or cancelled synthetic items can be retried');
      if (override?.collisionPolicy === 'replace') {
        const displayed = receipt.error?.destination; const expected = override.expectedDestination;
        const exact = this.store.sameFileState(displayed, expected) || this.store.sameFolderReplacementDestination(displayed, expected);

        if (!exact) throw new Error('Replace requires the exact displayed synthetic destination snapshot');
      }
      return { id, receipt, override };
    });

    for (const { id, receipt, override } of validated) {
      if (override) operation.retryOverrides[id] = SyntheticValues.clone(override);
      Object.assign(receipt, { state: 'pending', error: null, retryable: false });
    }
    operation.receipt.cancelRequested = false; this.refreshReceipt(operation); this.store.persist(); this.schedule(operationId);
    return SyntheticValues.clone(operation.receipt);
  }
  async undoOperation(operationId:string):Promise<FilesOperationReceipt> {
    const operation = this.operation(operationId);

    if (operation.receipt.state === 'pending') throw new Error('Wait for the synthetic operation to finish before undoing it');
    for (const item of [...operation.receipt.items].reverse().filter(value => value.state === 'completed')) {
      const mutation = operation.mutations[item.itemId];

      if (!mutation || !this.journal.mutationMatches(mutation, 'after')) {
        item.error = { status: 409, code: 'state-conflict', message: 'Synthetic undo was blocked because the current revision, collection, or namespace ownership changed.' }; item.undoSupported = false;
        this.refreshReceipt(operation); this.store.persist();
        return SyntheticValues.clone(operation.receipt);
      }
      this.journal.applyMutation(mutation, 'before'); item.state = 'undone'; item.error = null; item.undoSupported = false;
    }
    this.refreshReceipt(operation); this.store.persist();
    return SyntheticValues.clone(operation.receipt);
  }
  private operation(id:string) { const result = this.store.state.operations[id]; if (!result) throw new Error('Synthetic operation receipt was not found'); return result }
  private schedule(id:string, delay = 420) {
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.advance(id) }, delay));
  }
  private advance(id:string) {
    const operation = this.store.state.operations[id];

    if (!operation || operation.receipt.state !== 'pending') return;
    const pending = operation.receipt.items.filter(item => item.state === 'pending');
    if (operation.receipt.cancelRequested) pending.forEach(item => Object.assign(item, { state: 'cancelled', error: { status: 409, code: 'operation-cancelled', message: 'Cancelled before this synthetic item started.' }, retryable: true }));
    else if (pending[0]) this.executor.executeItem(operation, operation.request.items.find(item => item.itemId === pending[0].itemId)!, pending[0]);
    this.refreshReceipt(operation); this.store.persist();
    if (operation.receipt.state === 'pending') this.schedule(id);
  }
  private refreshReceipt(operation:SyntheticOperation) {
    const items = operation.receipt.items; const pending = items.some(item => item.state === 'pending'); const completed = items.some(item => item.state === 'completed'); const failed = items.some(item => item.state === 'failed'); const cancelled = items.some(item => item.state === 'cancelled'); const undone = items.some(item => item.state === 'undone'); const undoConflict = items.some(item => item.state === 'completed' && item.error?.code === 'state-conflict' && !item.undoSupported);

    operation.receipt.state = pending ? 'pending' : undone && !completed ? 'undone' : failed && !completed && !cancelled ? 'failed' : cancelled && !completed && !failed ? 'cancelled' : failed || cancelled || undone && completed || undoConflict ? 'partial' : 'completed';
    operation.receipt.undoSupported = !pending && items.some(item => item.state === 'completed' && item.undoSupported);
    operation.receipt.retryable = !pending && items.some(item => ['failed', 'cancelled'].includes(item.state) && item.retryable);
    operation.receipt.updatedAt = new Date().toISOString();
  }
}
