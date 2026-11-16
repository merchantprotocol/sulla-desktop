// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RelaySocketLike } from '../../../../main/cloudRelayTransport';
import type { DesktopRelayTimers } from '../../../../main/cloud/relay/DesktopRelayPorts';
import { DesktopRelayShareServer } from '../../../../main/cloud/relay/DesktopRelayShareServer';

const MB = 1024 * 1024;

class BufferingSocket implements RelaySocketLike {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  addEventListener(): void {}
  close(): void { this.readyState = 3 }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
    this.bufferedAmount += 5 * MB;
  }

  types(): unknown[] { return this.sent.map(frame => frame.type) }
}

class CountingBody {
  pulls = 0;
  readonly stream: ReadableStream<Uint8Array>;
  constructor(chunks: number) {
    this.stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        this.pulls++;
        if (this.pulls > chunks) controller.close();
        else controller.enqueue(new Uint8Array([this.pulls]));
      },
    }, { highWaterMark: 0 });
  }
}

const timers: DesktopRelayTimers = {
  now:           () => Date.now(),
  setTimeout:    (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout:  timer => clearTimeout(timer),
  setInterval:   (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: timer => clearInterval(timer),
};

function createServer(socket: BufferingSocket, body: CountingBody) {
  const current = { socket: socket as RelaySocketLike | null, generation: 1 };
  const files = {
    serviceToken: vi.fn().mockResolvedValue('files-token'),
    fetch:        vi.fn().mockResolvedValue(new Response(body.stream, { status: 200, headers: { 'content-type': 'application/pdf', 'x-sulla-filename': 'r%C3%A9sum%C3%A9.pdf' } })),
    origin:       () => 'https://127.0.0.1:30124',
  };
  const log = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { current, files, server: new DesktopRelayShareServer(current, files, timers, log) };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('DesktopRelayShareServer', () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  it('stops pulling from Files while the socket buffer is full and resumes once it drains', async() => {
    // risk: resource exhaustion — a large share must not be buffered into memory as queued frames.
    const socket = new BufferingSocket();
    const body = new CountingBody(3);
    const { server } = createServer(socket, body);
    const serving = server.serve({ type: 'share_fetch', requestId: 'q1', linkId: 'l1', path: 'a/b.pdf', range: 'bytes=0-' }, socket, 1);
    await settle();

    expect(socket.types()).toEqual(['share_fetch_start']);
    expect(socket.sent[0]).toMatchObject({ requestId: 'q1', status: 200, mime: 'application/pdf', name: 'résumé.pdf', contentLength: 0, acceptRanges: 'bytes' });
    expect(body.pulls).toBe(0);

    socket.bufferedAmount = 2 * MB;
    await settle(100);
    expect(body.pulls).toBe(0);

    socket.bufferedAmount = 0;
    await settle(10);
    expect(body.pulls).toBe(1);
    expect(socket.sent[1]).toEqual({ type: 'share_fetch_chunk', requestId: 'q1', data: Buffer.from([1]).toString('base64') });

    for (let i = 0; i < 5; i++) { socket.bufferedAmount = 0; await settle(10) }
    await serving;
    expect(socket.types()).toEqual(['share_fetch_start', 'share_fetch_chunk', 'share_fetch_chunk', 'share_fetch_chunk', 'share_fetch_end']);
  });

  it('sends the Files token, path and range to the pinned TLS origin', async() => {
    // risk: data accuracy — the right file range is requested with the right credential.
    const socket = new BufferingSocket();
    const { server, files } = createServer(socket, new CountingBody(0));
    const serving = server.serve({ type: 'share_fetch', requestId: 'q1', linkId: 'link/1', path: 'a b.pdf', range: 'bytes=5-9' }, socket, 1);
    await settle();

    const [url, init] = files.fetch.mock.calls[0];
    expect(String(url)).toBe('https://127.0.0.1:30124/v1/local/shares/link%2F1/content?path=a+b.pdf');
    expect(init.headers.get('X-Sulla-Files-Token')).toBe('files-token');
    expect(init.headers.get('Range')).toBe('bytes=5-9');
    server.abort();
    await settle(20);
    await serving;
  });

  it('aborts a share when its socket is released and sends nothing more', async() => {
    // risk: data accuracy — bytes for a dead connection must not leak onto its replacement.
    const socket = new BufferingSocket();
    const body = new CountingBody(3);
    const { server, current } = createServer(socket, body);
    const serving = server.serve({ type: 'share_fetch', requestId: 'q1', linkId: 'l1' }, socket, 1);
    await settle();

    server.abort(socket, 1);
    current.socket = new BufferingSocket();
    socket.bufferedAmount = 0;
    await settle(50);
    await serving;

    expect(socket.types()).toEqual(['share_fetch_start']);
    expect(body.pulls).toBe(0);
  });

  it('refuses a share requested on a socket that is no longer current', async() => {
    // risk: data accuracy — a stale connection cannot start a new share.
    const socket = new BufferingSocket();
    const { server, files, current } = createServer(socket, new CountingBody(1));
    current.generation = 2;
    await server.serve({ type: 'share_fetch', requestId: 'q1', linkId: 'l1' }, socket, 1);
    expect(files.fetch).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
  });

  it('reports a Files failure to mobile as share_fetch_error', async() => {
    // risk: data accuracy — mobile must learn the share failed instead of waiting forever.
    const socket = new BufferingSocket();
    const { server, files } = createServer(socket, new CountingBody(0));
    files.fetch.mockResolvedValue(new Response('link expired', { status: 404 }));
    await server.serve({ type: 'share_fetch', requestId: 'q1', linkId: 'l1' }, socket, 1);
    expect(socket.sent).toEqual([{ type: 'share_fetch_error', requestId: 'q1', error: 'link expired' }]);
  });
});
