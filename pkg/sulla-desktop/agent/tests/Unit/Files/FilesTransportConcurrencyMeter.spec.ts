// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { FilesTransportConcurrencyMeter, type FilesTransportOperation } from '../../../files/FilesTransportConcurrencyMeter';

const filesOperation:FilesTransportOperation = { transport:'node', method:'GET', pathname:'/v1/files' };

function withTimeout<T>(promise:Promise<T>, timeoutMs = 500):Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for un-gated Files request')), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    );
  });
}

describe('FilesTransportConcurrencyMeter', () => {
  it('lets the 101st request reach headers after 100 unread response bodies', async() => {
    // risk: availability — callers that discard error bodies must never exhaust a meter slot and stall Files.
    const meter = new FilesTransportConcurrencyMeter(() => 10, () => undefined);
    const unreadResponses = await withTimeout(Promise.all(Array.from({ length: 100 }, (_, index) => meter.run(
      { ...filesOperation, pathname:`/v1/files/synthetic-${ index }` },
      async() => new Response(new ReadableStream<Uint8Array>({ start() {} })),
    ))));

    const oneHundredFirst = await withTimeout(meter.run(filesOperation, async() => new Response('available')));
    const metrics = meter.snapshot()['node GET /v1/files'];
    expect(unreadResponses).toHaveLength(100);
    expect(await oneHundredFirst.text()).toBe('available');
    expect(metrics).toMatchObject({ active:0, bodyOpen:101, maxActive:100, count:101 });
    expect(Object.keys(meter.snapshot())).toEqual(['node GET /v1/files']);

    await Promise.all(unreadResponses.map(response => response.body?.cancel()));
    expect(meter.snapshot()['node GET /v1/files']?.bodyOpen).toBe(0);
  });

  it('measures request-to-headers separately and returns the original Response unchanged', async() => {
    // risk: availability — timing observation must preserve the real response and release bodyOpen on consumption.
    let now = 100;
    const meter = new FilesTransportConcurrencyMeter(() => now, () => undefined);
    let resolveResponse!:(response:Response) => void;
    const pendingResponse = new Promise<Response>(resolve => { resolveResponse = resolve });
    const resultPromise = meter.run(filesOperation, () => pendingResponse);
    expect(meter.snapshot()['node GET /v1/files']).toMatchObject({ active:1, bodyOpen:0, count:0, maxActive:1 });

    const response = new Response('body bytes');
    Object.defineProperty(response, 'url', { configurable:true, value:'https://127.0.0.1:30124/v1/files' });
    Object.defineProperty(response, 'redirected', { configurable:true, value:true });
    now = 135;
    resolveResponse(response);
    const result = await resultPromise;

    expect(result).toBe(response);
    expect(result.url).toBe('https://127.0.0.1:30124/v1/files');
    expect(result.redirected).toBe(true);
    expect(meter.snapshot()['node GET /v1/files']).toMatchObject({ active:0, bodyOpen:1, count:1, maxActive:1, totalMs:35, p95Ms:35 });
    await expect(result.text()).resolves.toBe('body bytes');
    expect(meter.snapshot()['node GET /v1/files']?.bodyOpen).toBe(0);
  });

  it('releases bodyOpen when a request is aborted after a partial body read', async() => {
    // risk: availability — cancellation of an in-progress download must clear its open-body measurement.
    const meter = new FilesTransportConcurrencyMeter(() => 10, () => undefined);
    const controller = new AbortController();
    const response = await meter.run(filesOperation, async() => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1]));
      },
    })), controller.signal);
    const reader = response.body!.getReader();

    await expect(reader.read()).resolves.toMatchObject({ done:false });
    expect(meter.snapshot()['node GET /v1/files']?.bodyOpen).toBe(1);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    expect(meter.snapshot()['node GET /v1/files']).toMatchObject({ active:0, bodyOpen:0, count:1 });

    await reader.cancel();
  });

  it('records a rejected request without retaining active state', async() => {
    // risk: availability — failed network attempts must leave the meter ready for subsequent Files work.
    const meter = new FilesTransportConcurrencyMeter(() => 10, () => undefined);
    await expect(meter.run(filesOperation, async() => { throw new Error('synthetic network failure') })).rejects.toThrow('synthetic network failure');

    expect(meter.snapshot()['node GET /v1/files']).toMatchObject({ active:0, bodyOpen:0, maxActive:1, count:1 });
  });
});
