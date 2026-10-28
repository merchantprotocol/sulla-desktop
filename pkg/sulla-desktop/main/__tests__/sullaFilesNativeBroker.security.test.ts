// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';

import { readBoundedResponse } from '../sullaFilesBoundedResponse';
import { NATIVE_SOURCE_REFRESH_INTERVAL_MS, SullaFilesNativeBroker, type NativeSourceBrokerDependencies } from '../sullaFilesNativeBroker';

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

function action(overrides:Partial<Awaited<ReturnType<NativeSourceBrokerDependencies['actions']>>[number]> = {}) {
  return {
    operationId:    randomUUID(),
    handle:         'h'.repeat(43),
    sourceRevision: 'a'.repeat(64),
    sourceHash:     'c'.repeat(64),
    desiredHash:    'b'.repeat(64),
    baseVersionId:  randomUUID(),
    versionId:      randomUUID(),
    state:          'publishing' as const,
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

    pendingActions.resolve([action()]);
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
      actions: () => Promise.resolve([action({ desiredHash })]),
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

  test('acknowledges a recovered publication with the exact durable source and Files identities', async() => {
    const bytes = Buffer.from('already published synthetic bytes');
    const desiredHash = createHash('sha256').update(bytes).digest('hex');
    const pending = action({ desiredHash, state: 'recovery-required' });
    const finish = jest.fn(() => Promise.resolve());
    const broker = new SullaFilesNativeBroker(dependencies({
      actions: () => Promise.resolve([pending]),
      content: () => Promise.resolve(bytes),
      read:    () => Promise.resolve({ bytes, contentHash: desiredHash, revision: 'd'.repeat(64) }),
      finish,
    }));

    broker.resume();
    await broker.poll();
    while (!finish.mock.calls.length) await Promise.resolve();
    expect(finish).toHaveBeenCalledWith(pending.operationId, {
      nextSourceRevision:      'd'.repeat(64),
      originalSourceRevision: pending.sourceRevision,
      originalSourceHash:     pending.sourceHash,
      currentSourceHash:      pending.desiredHash,
      filesBaseVersionId:     pending.baseVersionId,
      currentFilesVersionId:  pending.versionId,
    });
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

describe('native source broker polling cost', () => {
  const source = (handle:string, sourceRevision = 'a'.repeat(64)) => ({
    fileId: randomUUID(), versionId: randomUUID(), path: `${ handle.slice(0, 4) }.txt`, handle, name: 'n.txt', sourceRevision, state: 'active',
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  test('an idle poll lists sources at most once per refresh interval and reports no activity', async() => {
    let now = 1_000_000;
    const sources = jest.fn(() => Promise.resolve([]));
    const broker = new SullaFilesNativeBroker(dependencies({ sources, now: () => now }));

    broker.resume();
    for (let tick = 0; tick < 20; tick++) { await broker.poll(); now += 250 } // 5 s of 250 ms ticks
    expect(sources).toHaveBeenCalledTimes(1);
    expect(broker.lastPollActive).toBe(false);
    now += NATIVE_SOURCE_REFRESH_INTERVAL_MS;
    await broker.poll();
    expect(sources).toHaveBeenCalledTimes(2);
  });

  test('publication work keeps the poll hot', async() => {
    const broker = new SullaFilesNativeBroker(dependencies({
      actions: () => Promise.resolve([action()]),
      content: () => new Promise(() => undefined), // publication stays in flight
    }));

    broker.resume();
    await broker.poll();
    expect(broker.lastPollActive).toBe(true);
  });

  test('refresh skips re-reading a source whose descriptor signature is unchanged', async() => {
    let now = 1_000_000;
    let signature = 'dev:ino:10:1';
    const read = jest.fn(() => Promise.resolve({ bytes: Buffer.from('x'), contentHash: 'c'.repeat(64), revision: 'a'.repeat(64) }));
    const broker = new SullaFilesNativeBroker(dependencies({
      sources:   () => Promise.resolve([source('s'.repeat(43))]),
      read,
      signature: () => Promise.resolve(signature),
      now:       () => now,
    }));

    broker.resume();
    await broker.poll();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(broker.lastPollActive).toBe(true);

    now += NATIVE_SOURCE_REFRESH_INTERVAL_MS;
    await broker.poll();
    await settle();
    expect(read).toHaveBeenCalledTimes(1); // unchanged signature: no read
    expect(broker.lastPollActive).toBe(false);

    signature = 'dev:ino:11:2';
    now += NATIVE_SOURCE_REFRESH_INTERVAL_MS;
    await broker.poll();
    await settle();
    expect(read).toHaveBeenCalledTimes(2); // changed on disk: read again
  });
});
