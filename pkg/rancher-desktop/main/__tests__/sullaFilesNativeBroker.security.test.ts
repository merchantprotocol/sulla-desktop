import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';

import { readBoundedResponse } from '../sullaFilesBoundedResponse';
import { SullaFilesNativeBroker, type NativeSourceBrokerDependencies } from '../sullaFilesNativeBroker';

function deferred<T>() {
  let resolvePromise!:(value:T) => void;
  const promise = new Promise<T>(resolve => { resolvePromise = resolve });

  return { promise, resolve: resolvePromise };
}

function dependencies(overrides:Partial<NativeSourceBrokerDependencies> = {}):NativeSourceBrokerDependencies {
  return {
    actions:  () => Promise.resolve([]),
    sources:  () => Promise.resolve([]),
    content:  () => Promise.resolve(Buffer.alloc(0)),
    read:     () => Promise.resolve({ bytes: Buffer.alloc(0), contentHash: createHash('sha256').update('').digest('hex'), revision: 'a'.repeat(64) }),
    write:    () => Promise.resolve({ contentHash: createHash('sha256').update('').digest('hex'), revision: 'b'.repeat(64) }),
    ingest:   () => Promise.resolve({ id: randomUUID(), current_version_id: randomUUID() }),
    finish:   () => Promise.resolve(),
    logError: () => undefined,
    ...overrides,
  };
}

describe('native source broker lifecycle', () => {
  test('rejects action enrollment when a poll returns after lock began', async() => {
    const pendingActions = deferred<Awaited<ReturnType<NativeSourceBrokerDependencies['actions']>>>();
    const content = jest.fn(() => Promise.resolve(Buffer.from('bounded bytes')));
    const broker = new SullaFilesNativeBroker(dependencies({ actions: () => pendingActions.promise, content }));

    broker.resume();
    const poll = broker.poll();
    const lock = broker.suspendAndDrain(() => Promise.resolve());

    pendingActions.resolve([{ operationId: randomUUID(), handle: 'h'.repeat(43), sourceRevision: 'a'.repeat(64), desiredHash: 'b'.repeat(64) }]);
    await Promise.all([poll, lock]);
    expect(content).not.toHaveBeenCalled();
  });

  test('waits for enrolled work and rejects stale acknowledgement after source lock', async() => {
    const bytes = Buffer.from('synthetic publication');
    const desiredHash = createHash('sha256').update(bytes).digest('hex');
    const sourceRead = deferred<{ bytes: Buffer; contentHash: string; revision: string }>();
    const finish = jest.fn(() => Promise.resolve());
    const read = jest.fn(() => sourceRead.promise);
    const broker = new SullaFilesNativeBroker(dependencies({
      actions: () => Promise.resolve([{ operationId: randomUUID(), handle: 'h'.repeat(43), sourceRevision: 'a'.repeat(64), desiredHash }]),
      content: () => Promise.resolve(bytes),
      read,
      finish,
    }));

    broker.resume();
    const poll = broker.poll();
    while (!read.mock.calls.length) await Promise.resolve();
    let drained = false;
    const lock = broker.suspendAndDrain(() => Promise.resolve()).then(() => { drained = true });

    await Promise.resolve();
    expect(drained).toBe(false);
    sourceRead.resolve({ bytes, contentHash: desiredHash, revision: 'b'.repeat(64) });
    await Promise.all([poll, lock]);
    expect(finish).not.toHaveBeenCalled();
  });
});

describe('bounded native publication response', () => {
  test('cancels a response whose declared length exceeds the limit', async() => {
    const cancel = jest.fn(() => Promise.resolve());
    const response = {
      ok:      true,
      status:  200,
      headers: { get: () => '11' },
      body:    { cancel },
    } as unknown as Response;

    await expect(readBoundedResponse(response, 10)).rejects.toThrow('size bound');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('cancels a chunked response once it exceeds the byte limit', async() => {
    let cancelled = false;
    const chunks = [new Uint8Array(5), new Uint8Array(6)];
    const response = {
      ok:      true,
      status:  200,
      headers: { get: () => null },
      body:    {
        getReader: () => ({
          read:   () => Promise.resolve(chunks.length ? { done: false, value: chunks.shift()! } : { done: true, value: undefined }),
          cancel: () => { cancelled = true; return Promise.resolve() },
        }),
      },
    } as unknown as Response;

    await expect(readBoundedResponse(response, 10)).rejects.toThrow('size bound');
    expect(cancelled).toBe(true);
  });

  test('rejects an incorrect declared length', async() => {
    let sent = false;
    const response = {
      ok:      true,
      status:  200,
      headers: { get: () => '3' },
      body:    {
        getReader: () => ({
          read:   () => {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: new Uint8Array(4) });
          },
          cancel: () => Promise.resolve(),
        }),
      },
    } as unknown as Response;

    await expect(readBoundedResponse(response, 10)).rejects.toThrow('length changed');
  });
});
