// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));

import { SullaFilesIpcLiveHandlers } from './SullaFilesIpcLiveHandlers';
import { SullaFilesIpcApi } from './SullaFilesIpcSupport';

class FakeSender extends EventEmitter {
  readonly sent:[string, unknown][] = [];
  constructor(readonly id:number) { super() }
  isDestroyed() { return false }
  send(channel:string, payload:unknown) { this.sent.push([channel, payload]) }
}

function harness(streamBody = 'data: {"type":"update","n":1}\r\n\r\n') {
  const handlers = new Map<string, (...args:any[]) => any>();
  const client = {
    json:   vi.fn(async(endpoint:string, init:RequestInit = {}) => (endpoint.endsWith('/live') && init.method === 'POST' ? { peerId: 'peer-1' } : { ok: true })),
    stream: vi.fn(async() => new Response(streamBody, { status: 200 })),
  };
  new SullaFilesIpcLiveHandlers(new SullaFilesIpcApi(client as any)).register({ handle: (channel, listener) => { handlers.set(channel, listener) } });
  const call = (channel:string, sender:FakeSender, input:unknown) => handlers.get(channel)!({ sender }, input);

  return { call, client };
}

describe('SullaFilesIpcLiveHandlers', () => {
  it('lets only the renderer that joined drive a live peer', async() => {
    // risk: tenant isolation — another renderer guessing a peer id must not proxy that session.
    const { call, client } = harness();
    const owner = new FakeSender(1);
    const intruder = new FakeSender(2);
    await expect(call('sulla-files:live-join', owner, { fileId: 'f 1' })).resolves.toEqual({ peerId: 'peer-1' });
    await expect(call('sulla-files:live-sync', intruder, { peerId: 'peer-1', message: 'x' })).resolves.toEqual({ error: 'Live peer not found' });
    await expect(call('sulla-files:live-leave', intruder, { peerId: 'peer-1' })).resolves.toEqual({ error: 'Live peer not found' });
    await expect(call('sulla-files:live-sync', owner, { peerId: 'peer-1', message: 'hi' })).resolves.toEqual({ ok: true });
    expect(client.json).toHaveBeenLastCalledWith('/v1/files/f%201/live/peer-1/sync', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }, { server: false });
  });

  it('leaves the session on the server when the owner leaves or its window is destroyed', async() => {
    // risk: resource leak — abandoned live sessions must be deleted server-side exactly once.
    const { call, client } = harness();
    const owner = new FakeSender(1);
    await call('sulla-files:live-join', owner, { fileId: 'f1' });
    await expect(call('sulla-files:live-leave', owner, { peerId: 'peer-1' })).resolves.toEqual({});
    owner.emit('destroyed');
    await new Promise(resolve => setImmediate(resolve));
    const deletes = client.json.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'DELETE');
    expect(deletes).toEqual([['/v1/files/f1/live/peer-1', { method: 'DELETE' }, { server: false }]]);
  });

  it('returns join failures as data instead of throwing', async() => {
    // risk: error mapping — Electron drops custom error fields, so the editor reads { error }.
    const { call, client } = harness();
    client.json.mockRejectedValueOnce(new Error('Files offline'));
    await expect(call('sulla-files:live-join', new FakeSender(1), { fileId: 'f1' })).resolves.toEqual({ error: 'Files offline' });
  });

  it('forwards SSE frames to the owner and reports a disconnect', async() => {
    // risk: data integrity — collaborative updates must reach the editor; a dropped stream must be reported.
    const { call } = harness();
    const owner = new FakeSender(1);
    await call('sulla-files:live-join', owner, { fileId: 'f1' });
    await expect(call('sulla-files:live-start', owner, { peerId: 'peer-1' })).resolves.toEqual({});
    await vi.waitFor(() => expect(owner.sent).toHaveLength(2));
    expect(owner.sent).toEqual([
      ['sulla-files:live:peer-1', { type: 'update', n: 1 }],
      ['sulla-files:live:peer-1', { type: 'error', error: 'Live stream disconnected' }],
    ]);
  });
});
