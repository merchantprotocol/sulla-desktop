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
  const supported = () => source.capabilities.durableOperations === true && Boolean(source.submitOperation && source.getOperation);
  const current = computed(() => receipts.value[0] ?? null);
  const undoable = computed(() => receipts.value.find(receipt => receipt.undoSupported && receipt.state !== 'pending'));
  const storageKey = (collectionId:string) => `sulla:files:receipts:${ encodeURIComponent(tabId) }:${ encodeURIComponent(collectionId) }`;
  const restored = new Set<string>();

  function remember(receipt:FilesOperationReceipt) {
    const prior = receipts.value.find(item => item.operationId === receipt.operationId);
    if (prior && Date.parse(prior.updatedAt) > Date.parse(receipt.updatedAt)) return;
    receipts.value = [receipt, ...receipts.value.filter(item => item.operationId !== receipt.operationId)].slice(0, 30);
    try { sessionStorage.setItem(storageKey(receipt.collectionId), JSON.stringify(receipts.value.filter(item => item.collectionId === receipt.collectionId).map(item => item.operationId))) } catch { /* Receipts remain available in memory. */ }
  }
  async function restore(collectionId:string) {
    if (!supported() || active.value || restored.has(collectionId)) return;
    restored.add(collectionId);
    try {
      const ids:unknown = JSON.parse(sessionStorage.getItem(storageKey(collectionId)) || '[]');
      if (!Array.isArray(ids)) return;
      for (const id of ids.slice(0, 30).reverse()) {
        if (disposed || active.value) return;
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) continue;
        try { const receipt = await source.getOperation!(id); if (receipt.collectionId === collectionId && !disposed && !active.value) remember(receipt) } catch { /* A new session may no longer authorize a prior receipt. */ }
      }
    } catch { /* Invalid or unavailable session storage does not block browsing. */ }
  }
  async function follow(receipt:FilesOperationReceipt) {
    remember(receipt);
    const started = Date.now();
    while (!disposed && receipt.state === 'pending') {
      if (Date.now() - started > 30_000) { error.value = 'This operation is still pending. Check its status or retry remaining items to resume interrupted work.'; break }
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 750) });
      wake = undefined;
      if (disposed) break;
      receipt = await source.getOperation!(receipt.operationId);
      remember(receipt);
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
    pendingRequest.value = request;
    return run(async() => {
      const receipt = await source.submitOperation!(request);
      pendingRequest.value = null;
      return receipt;
    });
  }
  async function cancel(operationId:string) {
    if (!source.cancelOperation) return;
    try { remember(await source.cancelOperation(operationId)) }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  }
  const retry = (id:string, request?:FilesOperationRetry) => source.retryOperation ? run(() => source.retryOperation!(id, request)) : Promise.resolve(null);
  const undo = (id:string) => source.undoOperation ? run(() => source.undoOperation!(id)) : Promise.resolve(null);
  const resume = (id:string) => source.getOperation ? run(() => source.getOperation!(id)) : Promise.resolve(null);
  onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer); wake?.() });
  return { receipts, current, undoable, pendingRequest, error, active, supported, submit, cancel, retry, undo, resume, restore };
}
