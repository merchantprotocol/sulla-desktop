// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref } from 'vue';

import { FilesCollisionDestinations } from './FilesCollisionDestinations';

import type { FilesBrowserController } from './FilesBrowserController';
import type { FilesCollisionDestination, FilesCollisionPolicy, FilesOperationItemReceipt, FilesOperationReceipt, FilesOperationRetry } from '../types';

/** The operations tray: recent receipts for this collection, retry, collision choices, undo and recovery. */
export class FilesBrowserReceipts {
  readonly operationHistory = computed(() => {
    const collectionId = this.browser.state.snapshot.value?.collection.id; const operations = this.browser.operations;

    return operations.receipts.value.filter((receipt, index) => this.receiptTouchesCollection(receipt, collectionId) ||
      (operations.active.value && index === 0));
  });

  readonly operationReceipt = computed(() => this.operationHistory.value[0] ?? null);
  readonly undoReceipt = computed(() => [...this.operationHistory.value].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).find(receipt => receipt.undoSupported && receipt.state !== 'pending'));
  readonly collisionItem = computed(() => this.operationReceipt.value?.items.find(item => item.state === 'failed' && item.error?.code === 'destination-conflict'));
  readonly applyCollisionToAll = ref(false);
  readonly collisionItems = computed(() => {
    const receipt = this.operationReceipt.value; const selected = this.collisionItem.value;

    return receipt && selected ? (this.applyCollisionToAll.value ? receipt.items.filter(item => item.state === 'failed' && item.error?.code === 'destination-conflict') : [selected]) : [];
  });

  readonly canReplaceCollision = computed(() => this.collisionItems.value.length > 0 && this.collisionItems.value.every(item => Boolean(this.replaceCollisionDestination(item))));
  readonly canUndo = computed(() => { const state = this.browser.state; return !state.busy.value && !state.loading.value && !this.browser.operations.receipts.value.some(receipt => receipt.state === 'pending') && Boolean(state.props.dataSource.undoOperation && this.undoReceipt.value && this.receiptTouchesCollection(this.undoReceipt.value, state.snapshot.value?.collection.id)) });

  constructor(private readonly browser:FilesBrowserController) {}

  receiptTouchesCollection(receipt:FilesOperationReceipt, collectionId?:string):boolean {
    return this.browser.operations.touchesCollection(receipt, collectionId);
  }

  private replaceCollisionDestination(item:FilesOperationItemReceipt):FilesCollisionDestination | undefined {
    const state = this.browser.state;

    return FilesCollisionDestinations.replaceDestination(item, state.snapshot.value?.collection.id, state.props.dataSource.capabilities.folderCollisionPolicies?.includes('replace') === true);
  }

  readonly undoLastOperation = async():Promise<void> => {
    if (!this.canUndo.value || !this.undoReceipt.value) return;
    const id = this.undoReceipt.value.operationId;

    await this.browser.refresher.runMutation(async() => { await this.browser.operations.undo(id) });
  };

  readonly retryReceipt = async(itemId?:string):Promise<void> => {
    const state = this.browser.state; const receipt = this.operationReceipt.value;

    if (!receipt || !state.props.dataSource.retryOperation || !this.receiptTouchesCollection(receipt, state.snapshot.value?.collection.id)) return;
    await this.browser.refresher.runMutation(async() => { await this.browser.operations.retry(receipt.operationId, itemId ? { items: [{ itemId }] } : undefined) });
  };

  readonly resolveCollision = async(policy:FilesCollisionPolicy):Promise<void> => {
    const state = this.browser.state; const receipt = this.operationReceipt.value; const selected = this.collisionItem.value;

    if (!receipt || !selected || !state.props.dataSource.retryOperation || !this.receiptTouchesCollection(receipt, state.snapshot.value?.collection.id)) return;
    const items = this.collisionItems.value;
    const retryItems:NonNullable<FilesOperationRetry['items']> = [];

    for (const item of items) {
      if (policy === 'replace') {
        const expectedDestination = this.replaceCollisionDestination(item);

        if (!expectedDestination) { state.operationError.value = 'Replace requires an authorized, current destination snapshot for every selected conflict. Folder creation supports Keep Both or Skip.'; return }
        retryItems.push({ itemId: item.itemId, collisionPolicy: policy, expectedDestination });
      } else {
        retryItems.push({ itemId: item.itemId, collisionPolicy: policy });
      }
    }
    await this.browser.refresher.runMutation(async() => { await this.browser.operations.retry(receipt.operationId, { items: retryItems }) });
  };

  readonly recoverOperation = async():Promise<void> => {
    const state = this.browser.state; const operations = this.browser.operations;
    const request = operations.pendingRequest.value; const receipt = this.operationReceipt.value;

    if (request && request.collectionId !== state.snapshot.value?.collection.id && !request.items.some(item => item.targetCollectionId === state.snapshot.value?.collection.id)) { state.operationError.value = 'Return to a collection involved in the pending operation to recover it.'; return }
    await this.browser.refresher.runMutation(async() => { if (request) await operations.submit(request); else if (receipt) await operations.resume(receipt.operationId) });
  };

  readonly showOperation = async(operationId:string):Promise<void> => { await this.browser.refresher.runMutation(async() => { await this.browser.operations.resume(operationId) }) };

  /** Returned (not voided) so the template handler reports a rejection exactly as the inline call did. */
  readonly cancelOperation = (operationId:string) => this.browser.operations.cancel(operationId);
}
