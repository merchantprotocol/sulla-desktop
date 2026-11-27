// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { FilesTransportConcurrencyMeter } from '../../../files/FilesTransportConcurrencyMeter';

function deferred<T = void>():{ promise:Promise<T>; resolve:(value:T) => void } {
  let resolve!:(value:T) => void;
  const promise = new Promise<T>((done) => { resolve = done });
  return { promise, resolve };
}

describe('FilesTransportConcurrencyMeter', () => {
  it('runs 20 mixed reads and writes concurrently and records per-operation counts', async() => {
    // risk: availability — UI and agent file reads/writes must not inherit Chromium’s six-request queue.
    const meter = new FilesTransportConcurrencyMeter(64);
    const releaseRequests = deferred();
    let active = 0;
    let maxActive = 0;
    const operations = Array.from({ length: 20 }, (_, index) => {
      const method = index % 2 ? 'PUT' : 'GET';
      const operation = `${method} /v1/files`;
      return meter.run(operation, async() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await releaseRequests.promise;
        active -= 1;
        return { method };
      });
    });

    await new Promise(resolve => setImmediate(resolve));
    const snapshot = meter.snapshot();
    releaseRequests.resolve();
    await expect(Promise.all(operations)).resolves.toHaveLength(20);
    expect(maxActive).toBe(20);
    expect(snapshot['GET /v1/files']).toMatchObject({ active: 10, pending: 0, maxActive: 10 });
    expect(snapshot['PUT /v1/files']).toMatchObject({ active: 10, pending: 0, maxActive: 10 });
  });

  it('caps active requests at the configured bound and measures queue wait', async() => {
    // risk: availability — a burst must be bounded without exceeding the configured transport limit.
    let now = 0;
    const meter = new FilesTransportConcurrencyMeter(3, () => now);
    const releaseFirstWave = deferred();
    let active = 0;
    let maxActive = 0;
    const operations = Array.from({ length: 20 }, () => meter.run('GET /v1/files', async() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active <= 3) await releaseFirstWave.promise;
      active -= 1;
      return { ok: true };
    }));

    await new Promise(resolve => setImmediate(resolve));
    const beforeRelease = meter.snapshot()['GET /v1/files'];
    now = 10;
    releaseFirstWave.resolve();
    await Promise.all(operations);
    expect(beforeRelease).toMatchObject({ active: 3, pending: 17, maxActive: 3 });
    expect(maxActive).toBe(3);
    expect(meter.snapshot()['GET /v1/files']?.waitMs).toBeGreaterThanOrEqual(170);
  });

  it('lets healthy work proceed beside a hung request and releases an aborted active slot', async() => {
    // risk: availability — one hung Files call must not serialize unrelated work, and abort must free capacity.
    const meter = new FilesTransportConcurrencyMeter(2);
    const controller = new AbortController();
    const hungStarted = deferred();
    const hung = meter.run('GET /v1/files', () => new Promise((_resolve, reject) => {
      hungStarted.resolve();
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    }), controller.signal);
    await hungStarted.promise;
    let healthyStarted = false;
    const healthy = meter.run('PUT /v1/files', async() => {
      healthyStarted = true;
      return { ok: true };
    });
    await new Promise(resolve => setImmediate(resolve));
    const proceededBesideHungRequest = healthyStarted;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(hung).rejects.toThrow('cancelled');
    await expect(healthy).resolves.toEqual({ ok: true });
    expect(proceededBesideHungRequest).toBe(true);
    expect(meter.snapshot()['GET /v1/files']).toMatchObject({ active: 0, pending: 0 });
  });

  it('releases a streaming slot when the response body is cancelled', async() => {
    // risk: availability — abandoned downloads/streams must not occupy a bounded connection slot.
    const meter = new FilesTransportConcurrencyMeter(1);
    const response = await meter.run('GET /v1/files', async() => new Response(new ReadableStream<Uint8Array>({ start() {} })));
    let didStart = false;
    const next = meter.run('GET /v1/files', async() => {
      didStart = true;
      return { ok: true };
    });
    expect(meter.snapshot()['GET /v1/files']).toMatchObject({ active: 1, pending: 1 });

    await response.body?.cancel();
    await new Promise(resolve => setImmediate(resolve));
    if (didStart) await expect(next).resolves.toEqual({ ok: true });
    else void next;
    expect(didStart).toBe(true);
    expect(meter.snapshot()['GET /v1/files']).toMatchObject({ active: 0, pending: 0, maxActive: 1 });
  });

  it('removes a queued request when its signal aborts', async() => {
    // risk: availability — a cancelled waiter must not remain queued or consume the next available slot.
    const meter = new FilesTransportConcurrencyMeter(1);
    const controller = new AbortController();
    const hold = deferred();
    const active = meter.run('GET /v1/files', async() => {
      await hold.promise;
      return { ok: true };
    });
    const queued = meter.run('GET /v1/files', async() => ({ ok: false }), controller.signal);
    let queuedRejected = false;
    const observedQueue = queued.catch((error) => {
      queuedRejected = true;
      return error;
    });
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await new Promise(resolve => setImmediate(resolve));
    const afterAbort = meter.snapshot()['GET /v1/files'];
    hold.resolve();
    await expect(active).resolves.toEqual({ ok: true });
    await observedQueue;
    expect(afterAbort).toMatchObject({ active: 1, pending: 0 });
    expect(queuedRejected).toBe(true);
  });
});
