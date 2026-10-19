import { computed, onBeforeUnmount, ref } from 'vue';

import type { FilesDataSource, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry } from '../types';

export function useFilesOperationQueue(source:FilesDataSource, tabId:string) {
  const receipts = ref<FilesOperationReceipt[]>([]);
  const pendingRequest = ref<FilesOperationRequest | null>(null);
  const error = ref('');
  const active = ref(false);
  let disposed = false;
  let wake:(() => void) | undefined;
  let timer:ReturnType<typeof setTimeout> | undefined;
  let restoreGeneration = 0;
  const supported = () => source.capabilities.durableOperations === true && Boolean(source.submitOperation && source.getOperation);
  const current = computed(() => receipts.value[0] ?? null);
  const undoable = computed(() => receipts.value.find(receipt => receipt.undoSupported && receipt.state !== 'pending'));
  const storageKey = (collectionId:string) => `sulla:files:receipts:${ encodeURIComponent(tabId) }:${ encodeURIComponent(collectionId) }`;
  const pendingStorageKey = `sulla:files:pending-operation:${ encodeURIComponent(tabId) }`;
  const restored = new Set<string>();
  const restoring = new Set<string>();
  let pendingSerialized = '';

  function remember(receipt:FilesOperationReceipt):FilesOperationReceipt {
    const prior = receipts.value.find(item => item.operationId === receipt.operationId);
    const priorTime = prior ? Date.parse(prior.updatedAt) : Number.NaN;
    const nextTime = Date.parse(receipt.updatedAt);
    if (prior && Number.isFinite(priorTime) && (!Number.isFinite(nextTime) || priorTime > nextTime)) return prior;
    if (prior && priorTime === nextTime) {
      if (prior.state !== 'pending' && receipt.state === 'pending') return prior;
      receipt = { ...receipt, cancelRequested: prior.cancelRequested || receipt.cancelRequested };
    }
    receipts.value = [receipt, ...receipts.value.filter(item => item.operationId !== receipt.operationId)].slice(0, 30);
    try {
      const stored:unknown = JSON.parse(sessionStorage.getItem(storageKey(receipt.collectionId)) || '[]');
      const ids = Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : [];
      sessionStorage.setItem(storageKey(receipt.collectionId), JSON.stringify([receipt.operationId, ...ids.filter(id => id !== receipt.operationId)].slice(0, 30)));
    } catch { /* Receipts remain available in memory. */ }
    return receipt;
  }
  function restorePending() {
    if (pendingRequest.value) return;
    try {
      const serialized = sessionStorage.getItem(pendingStorageKey);
      if (!serialized) return;
      const request:unknown = JSON.parse(serialized);
      if (!request || typeof request !== 'object' || typeof (request as FilesOperationRequest).idempotencyKey !== 'string' ||
          typeof (request as FilesOperationRequest).collectionId !== 'string' || !Array.isArray((request as FilesOperationRequest).items)) {
        error.value = 'A saved operation request is invalid and cannot be recovered.';
        return;
      }
      pendingSerialized = serialized;
      pendingRequest.value = request as FilesOperationRequest;
    } catch { error.value = 'The pending operation could not be read from this tab session.' }
  }
  function stagePending(request:FilesOperationRequest):FilesOperationRequest | null {
    const serialized = JSON.stringify(request);
    if (pendingRequest.value) {
      if (serialized !== pendingSerialized) error.value = 'Recover the saved operation before starting a different one.';
      return serialized === pendingSerialized ? JSON.parse(pendingSerialized) as FilesOperationRequest : null;
    }
    try { sessionStorage.setItem(pendingStorageKey, serialized) }
    catch { error.value = 'This tab cannot safely save the operation for recovery, so nothing was submitted.'; return null }
    const saved = JSON.parse(serialized) as FilesOperationRequest;
    pendingSerialized = serialized;
    pendingRequest.value = JSON.parse(serialized) as FilesOperationRequest;
    return saved;
  }
  function clearPending(request:FilesOperationRequest, receipt:FilesOperationReceipt) {
    if (pendingSerialized !== JSON.stringify(request)) return;
    try {
      const ids:unknown = JSON.parse(sessionStorage.getItem(storageKey(receipt.collectionId)) || '[]');
      if (!Array.isArray(ids) || !ids.includes(receipt.operationId)) {
        error.value = 'The operation was accepted, but this tab could not save its receipt for recovery.';
        return;
      }
    } catch { error.value = 'The operation was accepted, but this tab could not verify its saved receipt.'; return }
    try { sessionStorage.removeItem(pendingStorageKey) }
    catch { error.value = 'The operation was accepted, but this tab could not clear its saved recovery request.'; return }
    pendingSerialized = '';
    pendingRequest.value = null;
  }
  async function restore(collectionId:string) {
    restorePending();
    if (!supported() || active.value || restored.has(collectionId) || restoring.has(collectionId)) return;
    const generation = ++restoreGeneration;
    restoring.add(collectionId);
    let complete = true;
    try {
      const ids:unknown = JSON.parse(sessionStorage.getItem(storageKey(collectionId)) || '[]');
      if (!Array.isArray(ids)) return;
      for (const id of ids.slice(0, 30).reverse()) {
        if (disposed || active.value || generation !== restoreGeneration) { complete = false; return }
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) continue;
        try {
          const receipt = await source.getOperation!(id);
          if (disposed || active.value || generation !== restoreGeneration) { complete = false; return }
          if (receipt.collectionId === collectionId) remember(receipt);
        } catch { complete = false }
      }
    } catch { complete = false }
    finally {
      restoring.delete(collectionId);
      if (complete && !disposed && !active.value && generation === restoreGeneration) restored.add(collectionId);
    }
  }
  async function follow(receipt:FilesOperationReceipt) {
    receipt = remember(receipt);
    const started = Date.now();
    while (!disposed && receipt.state === 'pending') {
      if (Date.now() - started > 30_000) { error.value = 'This operation is still pending. Check its status or retry remaining items to resume interrupted work.'; break }
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 750) });
      wake = undefined;
      if (disposed) break;
      receipt = remember(await source.getOperation!(receipt.operationId));
    }
    return receipt;
  }
  async function run(action:() => Promise<FilesOperationReceipt>) {
    if (active.value || disposed) return null;
    active.value = true; error.value = '';
    try { return await follow(await action()) }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return null }
    finally { active.value = false }
  }
  async function submit(request:FilesOperationRequest) {
    if (!supported() || active.value || disposed) return null;
    const saved = stagePending(request);
    if (!saved) return null;
    return run(async() => {
      const receipt = await source.submitOperation!(saved);
      remember(receipt);
      clearPending(saved, receipt);
      return receipt;
    });
  }
  async function cancel(operationId:string) {
    if (!source.cancelOperation) return;
    try { remember(await source.cancelOperation(operationId)); wake?.() }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  }
  const retry = (id:string, request?:FilesOperationRetry) => source.retryOperation ? run(() => source.retryOperation!(id, request)) : Promise.resolve(null);
  const undo = (id:string) => source.undoOperation ? run(() => source.undoOperation!(id)) : Promise.resolve(null);
  const resume = (id:string) => source.getOperation ? run(() => source.getOperation!(id)) : Promise.resolve(null);
  onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer); wake?.() });
  return { receipts, current, undoable, pendingRequest, error, active, supported, submit, cancel, retry, undo, resume, restore };
}
