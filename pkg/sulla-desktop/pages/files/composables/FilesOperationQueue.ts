// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref, type ComputedRef, type Ref } from 'vue';

import type { FilesDataSource, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry } from '../types';

/** The slice of Web Storage the queue needs; the composable passes the tab's sessionStorage. */
export interface FilesOperationQueueStorage {
  getItem(key:string):string | null;
  setItem(key:string, value:string):void;
  removeItem(key:string):void;
}

interface OperationAssociation { source:string; targets:string[] }

/**
 * Durable file-operation receipts for one Files tab: submits, follows, cancels, retries, undoes
 * and restores receipts, and keeps tab-session recovery hints. Every receipt and mutation is still
 * authorized by the service; the saved hints only help this tab find its receipts after reload.
 */
export class FilesOperationQueue {
  private static readonly HISTORY_LIMIT = 30;
  private static readonly POLL_INTERVAL_MS = 750;
  private static readonly FOLLOW_LIMIT_MS = 30_000;
  private static readonly MAX_ASSOCIATED_TARGETS = 250;
  private static readonly MAX_COLLECTION_ID_LENGTH = 256;
  private static readonly OPERATION_ID = /^[0-9a-f-]{36}$/i;

  readonly receipts:Ref<FilesOperationReceipt[]> = ref([]);
  readonly pendingRequest:Ref<FilesOperationRequest | null> = ref(null);
  readonly error = ref('');
  readonly active = ref(false);
  readonly current:ComputedRef<FilesOperationReceipt | null> = computed(() => this.receipts.value[0] ?? null);
  readonly undoable:ComputedRef<FilesOperationReceipt | undefined> = computed(() => this.receipts.value.find(receipt => receipt.undoSupported && receipt.state !== 'pending'));

  private readonly associations = ref<Record<string, OperationAssociation>>({});
  private readonly pendingStorageKey:string;
  // UI recovery metadata only. Every receipt and mutation is still authorized by the service.
  private readonly associationStorageKey:string;
  private readonly restored = new Set<string>();
  private readonly restoring = new Set<string>();
  private pendingSerialized = '';
  private disposed = false;
  private wake:(() => void) | undefined;
  private timer:ReturnType<typeof setTimeout> | undefined;
  private restoreGeneration = 0;

  constructor(private readonly source:FilesDataSource, private readonly tabId:string, private readonly storage:FilesOperationQueueStorage) {
    this.pendingStorageKey = `sulla:files:pending-operation:${ encodeURIComponent(tabId) }`;
    this.associationStorageKey = `sulla:files:operation-collections:${ encodeURIComponent(tabId) }`;
    this.loadAssociations();
  }

  supported():boolean {
    return this.source.capabilities.durableOperations === true && Boolean(this.source.submitOperation && this.source.getOperation);
  }

  touchesCollection(receipt:FilesOperationReceipt, collectionId?:string):boolean {
    if (!collectionId) return false;
    const association = this.associations.value[receipt.operationId];

    return receipt.collectionId === collectionId ||
      (association?.source === receipt.collectionId && association.targets.includes(collectionId)) ||
      receipt.items.some(item => [item.before, item.after, item.displacedBefore, item.displacedAfter, item.error?.destination].some(state => state?.collectionId === collectionId));
  }

  async submit(request:FilesOperationRequest):Promise<FilesOperationReceipt | null> {
    if (!this.supported() || this.active.value || this.disposed) return null;
    const saved = this.stagePending(request);

    if (!saved) return null;
    return this.run(async() => {
      const receipt = await this.source.submitOperation!(saved);

      this.associate(saved, receipt);
      this.remember(receipt);
      this.clearPending(saved, receipt);
      return receipt;
    });
  }

  async cancel(operationId:string):Promise<void> {
    if (!this.source.cancelOperation) return;
    try { this.remember(await this.source.cancelOperation(operationId)); this.wake?.() }
    catch (cause) { this.error.value = cause instanceof Error ? cause.message : String(cause) }
  }

  retry(id:string, request?:FilesOperationRetry):Promise<FilesOperationReceipt | null> {
    return this.source.retryOperation ? this.run(() => this.source.retryOperation!(id, request)) : Promise.resolve(null);
  }

  undo(id:string):Promise<FilesOperationReceipt | null> {
    return this.source.undoOperation ? this.run(() => this.source.undoOperation!(id)) : Promise.resolve(null);
  }

  resume(id:string):Promise<FilesOperationReceipt | null> {
    return this.source.getOperation ? this.run(() => this.source.getOperation!(id)) : Promise.resolve(null);
  }

  /** Reloads this tab's saved receipts that touch `collectionId`, oldest first, once per collection. */
  async restore(collectionId:string):Promise<void> {
    this.restorePending();
    if (!this.supported() || this.active.value || this.restored.has(collectionId) || this.restoring.has(collectionId)) return;
    const generation = ++this.restoreGeneration;
    let complete = true;

    this.restoring.add(collectionId);
    try {
      const ids:unknown = JSON.parse(this.storage.getItem(this.storageKey(collectionId)) || '[]');

      if (!Array.isArray(ids)) return;
      for (const id of ids.slice(0, FilesOperationQueue.HISTORY_LIMIT).reverse()) {
        if (this.restoreInterrupted(generation)) { complete = false; return }
        if (typeof id !== 'string' || !FilesOperationQueue.OPERATION_ID.test(id)) continue;
        try {
          const receipt = await this.source.getOperation!(id);

          if (this.restoreInterrupted(generation)) { complete = false; return }
          if (this.touchesCollection(receipt, collectionId)) this.remember(receipt);
        } catch { complete = false }
      }
    } catch { complete = false } finally {
      this.restoring.delete(collectionId);
      if (complete && !this.restoreInterrupted(generation)) this.restored.add(collectionId);
    }
  }

  /** Stops polling and wakes any waiting follow loop; called when the owning component unmounts. */
  dispose():void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }

  private restoreInterrupted(generation:number):boolean {
    return this.disposed || this.active.value || generation !== this.restoreGeneration;
  }

  private storageKey(collectionId:string):string {
    return `sulla:files:receipts:${ encodeURIComponent(this.tabId) }:${ encodeURIComponent(collectionId) }`;
  }

  private validCollection(value:unknown):value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= FilesOperationQueue.MAX_COLLECTION_ID_LENGTH;
  }

  private loadAssociations():void {
    try {
      const saved:unknown = JSON.parse(this.storage.getItem(this.associationStorageKey) || '{}');

      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, raw] of Object.entries(saved).slice(0, FilesOperationQueue.HISTORY_LIMIT)) {
          if (!FilesOperationQueue.OPERATION_ID.test(id) || !raw || typeof raw !== 'object') continue;
          const value = raw as { source?:unknown; targets?:unknown };

          if (this.validCollection(value.source) && Array.isArray(value.targets) && value.targets.length <= FilesOperationQueue.MAX_ASSOCIATED_TARGETS && value.targets.every(target => this.validCollection(target))) {
            this.associations.value[id] = { source: value.source, targets: [...new Set(value.targets as string[])] };
          }
        }
      }
    } catch { /* Invalid recovery hints never authorize an operation. */ }
  }

  private associate(request:FilesOperationRequest, receipt:FilesOperationReceipt):void {
    if (request.collectionId !== receipt.collectionId) throw new Error('The operation receipt does not match its submitted collection.');
    const targets = [...new Set(request.items.map(item => item.targetCollectionId).filter((value):value is string => this.validCollection(value)))];

    this.associations.value = Object.fromEntries([
      [receipt.operationId, { source: request.collectionId, targets }],
      ...Object.entries(this.associations.value).filter(([id]) => id !== receipt.operationId),
    ].slice(0, FilesOperationQueue.HISTORY_LIMIT));
    try { this.storage.setItem(this.associationStorageKey, JSON.stringify(this.associations.value)) } catch { this.error.value = 'The operation was accepted, but destination history could not be saved for reload.' }
  }

  private remember(receipt:FilesOperationReceipt):FilesOperationReceipt {
    const prior = this.receipts.value.find(item => item.operationId === receipt.operationId);
    const priorTime = prior ? Date.parse(prior.updatedAt) : Number.NaN;
    const nextTime = Date.parse(receipt.updatedAt);

    if (prior && Number.isFinite(priorTime) && (!Number.isFinite(nextTime) || priorTime > nextTime)) return prior;
    if (prior && priorTime === nextTime) {
      if (prior.state !== 'pending' && receipt.state === 'pending') return prior;
      receipt = { ...receipt, cancelRequested: prior.cancelRequested || receipt.cancelRequested };
    }
    this.receipts.value = [receipt, ...this.receipts.value.filter(item => item.operationId !== receipt.operationId)].slice(0, FilesOperationQueue.HISTORY_LIMIT);
    try {
      const association = this.associations.value[receipt.operationId];
      const collections = new Set([receipt.collectionId, ...(association?.source === receipt.collectionId ? association.targets : [])]);

      for (const collectionId of collections) {
        const stored:unknown = JSON.parse(this.storage.getItem(this.storageKey(collectionId)) || '[]');
        const ids = Array.isArray(stored) ? stored.filter(id => typeof id === 'string' && FilesOperationQueue.OPERATION_ID.test(id)) : [];

        this.storage.setItem(this.storageKey(collectionId), JSON.stringify([receipt.operationId, ...ids.filter(id => id !== receipt.operationId)].slice(0, FilesOperationQueue.HISTORY_LIMIT)));
      }
    } catch { /* Receipts remain available in memory. */ }
    return receipt;
  }

  private restorePending():void {
    if (this.pendingRequest.value) return;
    try {
      const serialized = this.storage.getItem(this.pendingStorageKey);

      if (!serialized) return;
      const request:unknown = JSON.parse(serialized);

      if (!request || typeof request !== 'object' || typeof (request as FilesOperationRequest).idempotencyKey !== 'string' ||
          typeof (request as FilesOperationRequest).collectionId !== 'string' || !Array.isArray((request as FilesOperationRequest).items)) {
        this.error.value = 'A saved operation request is invalid and cannot be recovered.';
        return;
      }
      this.pendingSerialized = serialized;
      this.pendingRequest.value = request as FilesOperationRequest;
    } catch { this.error.value = 'The pending operation could not be read from this tab session.' }
  }

  private stagePending(request:FilesOperationRequest):FilesOperationRequest | null {
    const serialized = JSON.stringify(request);

    if (this.pendingRequest.value) {
      if (serialized !== this.pendingSerialized) this.error.value = 'Recover the saved operation before starting a different one.';
      return serialized === this.pendingSerialized ? JSON.parse(this.pendingSerialized) as FilesOperationRequest : null;
    }
    try { this.storage.setItem(this.pendingStorageKey, serialized) } catch { this.error.value = 'This tab cannot safely save the operation for recovery, so nothing was submitted.'; return null }
    const saved = JSON.parse(serialized) as FilesOperationRequest;

    this.pendingSerialized = serialized;
    this.pendingRequest.value = JSON.parse(serialized) as FilesOperationRequest;
    return saved;
  }

  private clearPending(request:FilesOperationRequest, receipt:FilesOperationReceipt):void {
    if (this.pendingSerialized !== JSON.stringify(request)) return;
    try {
      const ids:unknown = JSON.parse(this.storage.getItem(this.storageKey(receipt.collectionId)) || '[]');

      if (!Array.isArray(ids) || !ids.includes(receipt.operationId)) {
        this.error.value = 'The operation was accepted, but this tab could not save its receipt for recovery.';
        return;
      }
    } catch { this.error.value = 'The operation was accepted, but this tab could not verify its saved receipt.'; return }
    try { this.storage.removeItem(this.pendingStorageKey) } catch { this.error.value = 'The operation was accepted, but this tab could not clear its saved recovery request.'; return }
    this.pendingSerialized = '';
    this.pendingRequest.value = null;
  }

  private async follow(receipt:FilesOperationReceipt):Promise<FilesOperationReceipt> {
    receipt = this.remember(receipt);
    const started = Date.now();

    while (!this.disposed && receipt.state === 'pending') {
      if (Date.now() - started > FilesOperationQueue.FOLLOW_LIMIT_MS) { this.error.value = 'This operation is still pending. Check its status or retry remaining items to resume interrupted work.'; break }
      await new Promise<void>(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, FilesOperationQueue.POLL_INTERVAL_MS) });
      this.wake = undefined;
      if (this.disposed) break;
      receipt = this.remember(await this.source.getOperation!(receipt.operationId));
    }
    return receipt;
  }

  private async run(action:() => Promise<FilesOperationReceipt>):Promise<FilesOperationReceipt | null> {
    if (this.active.value || this.disposed) return null;
    this.active.value = true; this.error.value = '';
    try { return await this.follow(await action()) } catch (cause) { this.error.value = cause instanceof Error ? cause.message : String(cause); return null } finally { this.active.value = false }
  }
}
