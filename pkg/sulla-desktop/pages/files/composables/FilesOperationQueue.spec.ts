// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: irreversible side effects + data integrity. The queue is the only thing between a Files
// tab and durable move/copy/trash operations: it must never submit twice or submit something it
// could not save for recovery, must follow receipts until they settle, must keep newest receipts
// over stale ones, and must surface every service error instead of swallowing it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesOperationQueue, type FilesOperationQueueStorage } from './FilesOperationQueue';

import type { FilesDataSource, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry } from '../types';

const OP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const OP_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const OP_C = 'cccccccc-0000-4000-8000-000000000003';

class MemoryStorage implements FilesOperationQueueStorage {
  readonly values = new Map<string, string>();
  failWrites = false;
  getItem(key:string) { return this.values.get(key) ?? null }
  setItem(key:string, value:string) { if (this.failWrites) throw new Error('quota'); this.values.set(key, value) }
  removeItem(key:string) { this.values.delete(key) }
  json(key:string):unknown { const raw = this.values.get(key); return raw === undefined ? undefined : JSON.parse(raw) }
}

/** In-memory durable operation service: each operation advances through a scripted list of states. */
class FakeOperationService {
  readonly capabilities = { durableOperations: true } as FilesDataSource['capabilities'];
  readonly calls:string[] = [];
  readonly scripts = new Map<string, FilesOperationReceipt['state'][]>();
  submitError:Error | null = null;
  nextOperationId = OP_A;
  private clock = Date.parse('2026-11-16T00:00:00.000Z');
  private readonly collections = new Map<string, string>();

  receipt(operationId:string, state:FilesOperationReceipt['state'], extra:Partial<FilesOperationReceipt> = {}):FilesOperationReceipt {
    this.clock += 1000;
    return { operationId, collectionId: this.collections.get(operationId) ?? 'c1', state, cancelRequested: false, undoSupported: state === 'completed', retryable: false, createdAt: new Date(this.clock).toISOString(), updatedAt: new Date(this.clock).toISOString(), items: [], ...extra };
  }

  submitOperation = async(request:FilesOperationRequest):Promise<FilesOperationReceipt> => {
    this.calls.push(`submit:${ request.idempotencyKey }`);
    if (this.submitError) throw this.submitError;
    this.collections.set(this.nextOperationId, request.collectionId);
    return this.advance(this.nextOperationId);
  };

  getOperation = async(operationId:string):Promise<FilesOperationReceipt> => { this.calls.push(`get:${ operationId }`); return this.advance(operationId) };
  cancelOperation = async(operationId:string):Promise<FilesOperationReceipt> => { this.calls.push(`cancel:${ operationId }`); return this.receipt(operationId, 'pending', { cancelRequested: true }) };
  retryOperation = async(operationId:string, request?:FilesOperationRetry):Promise<FilesOperationReceipt> => { this.calls.push(`retry:${ operationId }:${ JSON.stringify(request ?? null) }`); return this.receipt(operationId, 'completed') };
  undoOperation = async(operationId:string):Promise<FilesOperationReceipt> => { this.calls.push(`undo:${ operationId }`); throw new Error('Undo was blocked because the file changed.') };

  private advance(operationId:string):FilesOperationReceipt {
    const script = this.scripts.get(operationId) ?? ['completed'];
    const state = script.length > 1 ? script.shift()! : script[0];

    return this.receipt(operationId, state);
  }
}

const request = (key = 'idem-1', extra:Partial<FilesOperationRequest> = {}):FilesOperationRequest => ({
  idempotencyKey: key, collectionId: 'c1', items: [{ itemId: 'i1', action: 'move', fileId: 'f1', targetPath: 'Archive/a.txt', targetCollectionId: 'c2' }], ...extra,
});

describe('FilesOperationQueue', () => {
  let service:FakeOperationService;
  let storage:MemoryStorage;
  let queue:FilesOperationQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T00:00:00.000Z'));
    service = new FakeOperationService();
    storage = new MemoryStorage();
    queue = new FilesOperationQueue(service as unknown as FilesDataSource, 'tab 1', storage);
  });
  afterEach(() => { queue.dispose(); vi.useRealTimers() });

  it('refuses to submit when the source has no durable operations', async() => {
    service.capabilities.durableOperations = false;

    expect(await queue.submit(request())).toBeNull();
    expect(service.calls).toEqual([]);
  });

  it('submits once, follows a pending receipt until it settles and indexes it for source and target collections', async() => {
    service.scripts.set(OP_A, ['pending', 'pending', 'completed']);
    const done = queue.submit(request());

    await vi.advanceTimersByTimeAsync(0);
    expect(queue.active.value).toBe(true);
    expect(queue.current.value?.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    const receipt = await done;

    expect(receipt?.state).toBe('completed');
    expect(service.calls).toEqual(['submit:idem-1', `get:${ OP_A }`, `get:${ OP_A }`]);
    expect(queue.active.value).toBe(false);
    expect(queue.pendingRequest.value).toBeNull();
    expect(storage.getItem('sulla:files:pending-operation:tab%201')).toBeNull();
    expect(storage.json('sulla:files:receipts:tab%201:c1')).toEqual([OP_A]);
    expect(storage.json('sulla:files:receipts:tab%201:c2')).toEqual([OP_A]);
    expect(queue.touchesCollection(queue.current.value!, 'c2')).toBe(true);
    expect(queue.touchesCollection(queue.current.value!, 'other')).toBe(false);
    expect(queue.undoable.value?.operationId).toBe(OP_A);
  });

  it('submits nothing when the request cannot be saved for recovery', async() => {
    storage.failWrites = true;

    expect(await queue.submit(request())).toBeNull();
    expect(service.calls).toEqual([]);
    expect(queue.error.value).toBe('This tab cannot safely save the operation for recovery, so nothing was submitted.');
  });

  it('keeps a failed submission saved for recovery and blocks a different request until it is recovered', async() => {
    service.submitError = new Error('Files service is unavailable.');

    expect(await queue.submit(request())).toBeNull();
    expect(queue.error.value).toBe('Files service is unavailable.');
    expect(queue.active.value).toBe(false);
    expect(queue.pendingRequest.value?.idempotencyKey).toBe('idem-1');

    expect(await queue.submit(request('idem-2'))).toBeNull();
    expect(queue.error.value).toBe('Recover the saved operation before starting a different one.');
    expect(service.calls).toEqual(['submit:idem-1']);

    service.submitError = null;
    expect((await queue.submit(request()))?.state).toBe('completed');
    expect(service.calls).toEqual(['submit:idem-1', 'submit:idem-1']);
    expect(queue.pendingRequest.value).toBeNull();
  });

  it('recovers the saved request in a reloaded tab and re-submits it with the same idempotency key', async() => {
    service.submitError = new Error('offline');
    await queue.submit(request());
    const reloaded = new FilesOperationQueue(service as unknown as FilesDataSource, 'tab 1', storage);

    await reloaded.restore('c1');
    expect(reloaded.pendingRequest.value).toEqual(request());
    service.submitError = null;
    expect((await reloaded.submit(reloaded.pendingRequest.value!))?.operationId).toBe(OP_A);
    expect(service.calls).toEqual(['submit:idem-1', 'submit:idem-1']);
    reloaded.dispose();
  });

  it('rejects a receipt for a different collection than the one submitted', async() => {
    service.submitOperation = async() => service.receipt(OP_A, 'completed', { collectionId: 'someone-else' });

    expect(await queue.submit(request())).toBeNull();
    expect(queue.error.value).toBe('The operation receipt does not match its submitted collection.');
    expect(queue.receipts.value).toEqual([]);
  });

  it('cancel records the request and wakes the follow loop immediately', async() => {
    service.scripts.set(OP_A, ['pending', 'pending', 'cancelled']);
    const done = queue.submit(request());

    await vi.advanceTimersByTimeAsync(0);
    await queue.cancel(OP_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.calls).toEqual(['submit:idem-1', `cancel:${ OP_A }`, `get:${ OP_A }`]);
    await vi.advanceTimersByTimeAsync(750);
    expect((await done)?.state).toBe('cancelled');
  });

  it('stops following after 30 seconds and tells the user the operation is still pending', async() => {
    service.scripts.set(OP_A, ['pending']);
    const done = queue.submit(request());

    await vi.advanceTimersByTimeAsync(31_000);
    expect((await done)?.state).toBe('pending');
    expect(queue.error.value).toBe('This operation is still pending. Check its status or retry remaining items to resume interrupted work.');
    expect(queue.active.value).toBe(false);
  });

  it('passes retry selections through and surfaces undo conflicts as errors', async() => {
    expect((await queue.retry(OP_B, { items: [{ itemId: 'i1', collisionPolicy: 'keep-both' }] }))?.state).toBe('completed');
    expect(service.calls).toEqual([`retry:${ OP_B }:{"items":[{"itemId":"i1","collisionPolicy":"keep-both"}]}`]);
    expect(await queue.undo(OP_B)).toBeNull();
    expect(queue.error.value).toBe('Undo was blocked because the file changed.');
  });

  it('returns null without calling the service when retry, undo or resume are unsupported', async() => {
    const bare = new FilesOperationQueue({ capabilities: { durableOperations: true } } as FilesDataSource, 't', storage);

    expect(await bare.retry(OP_A)).toBeNull();
    expect(await bare.undo(OP_A)).toBeNull();
    expect(await bare.resume(OP_A)).toBeNull();
    expect(bare.supported()).toBe(false);
  });

  it('never replaces a newer receipt with an older or regressed one', async() => {
    await queue.resume(OP_A);
    const newest = queue.current.value!;
    service.getOperation = async() => ({ ...newest, state: 'pending', updatedAt: '2020-01-01T00:00:00.000Z' });

    await queue.resume(OP_A);
    expect(queue.current.value).toEqual(newest);

    service.getOperation = async() => ({ ...newest, state: 'pending' });
    await queue.resume(OP_A);
    expect(queue.current.value?.state).toBe('completed');
  });

  it('restores saved receipts oldest first, only for the collection, once per collection', async() => {
    storage.setItem('sulla:files:receipts:tab%201:c1', JSON.stringify([OP_C, 'not-an-id', OP_B, OP_A]));
    service.getOperation = async(operationId:string) => {
      service.calls.push(`get:${ operationId }`);
      return service.receipt(operationId, 'completed', { collectionId: operationId === OP_B ? 'elsewhere' : 'c1' });
    };

    await queue.restore('c1');
    expect(service.calls).toEqual([`get:${ OP_A }`, `get:${ OP_B }`, `get:${ OP_C }`]);
    expect(queue.receipts.value.map(receipt => receipt.operationId)).toEqual([OP_C, OP_A]);
    await queue.restore('c1');
    expect(service.calls).toHaveLength(3);
  });

  it('ignores tampered association hints from storage', async() => {
    storage.setItem('sulla:files:operation-collections:tab%201', JSON.stringify({ 'not-a-uuid': { source: 'c1', targets: ['c9'] }, [OP_A]: { source: 'c1', targets: [42] } }));
    const reloaded = new FilesOperationQueue(service as unknown as FilesDataSource, 'tab 1', storage);

    expect(reloaded.touchesCollection(service.receipt(OP_A, 'completed'), 'c9')).toBe(false);
    reloaded.dispose();
  });

  it('stops polling once disposed', async() => {
    service.scripts.set(OP_A, ['pending']);
    const done = queue.submit(request());

    await vi.advanceTimersByTimeAsync(0);
    queue.dispose();
    expect((await done)?.state).toBe('pending');
    expect(service.calls).toEqual(['submit:idem-1']);
    expect(await queue.submit(request('idem-9'))).toBeNull();
  });
});
