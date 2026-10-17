import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultVaultRelayManager } from './relays.js';

const credential = 'xapp-synthetic-private-credential';
const socketTicket = 'synthetic-private-socket-ticket';

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static latest: MockWebSocket | undefined;

  readonly url:  string;
  readyState = MockWebSocket.OPEN;
  readonly sent: string[] = [];
  closeCode?:    number;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.latest = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code }));
  }

  message(data: string): void {
    const event = new Event('message') as MessageEvent;
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}

function slackBootstrap(): Response {
  return Response.json({ ok: true, url: `wss://wss-primary.slack.com/link/?ticket=${ socketTicket }` });
}

async function withSlackRelay(run: (manager: DefaultVaultRelayManager, socket: MockWebSocket) => Promise<void> | void): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.fetch = ((_input, init) => {
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Promise.resolve(slackBootstrap());
  }) as typeof fetch;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  const manager = new DefaultVaultRelayManager();
  try {
    await manager.open({
      relayId: 'relay-1', operation: 'slack.socket-mode', credential, abortSignal: new AbortController().signal,
    });
    assert.ok(MockWebSocket.latest);
    await run(manager, MockWebSocket.latest);
  } finally {
    manager.closeAll('test_complete');
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    MockWebSocket.latest = undefined;
  }
}

test('redacts owned credential and ticket values from relay events', async() => {
  await withSlackRelay(async(manager, socket) => {
    socket.message(JSON.stringify({
      envelope_id: 'envelope-1',
      type:        'events_api',
      payload:     {
        text:         `credential=${ credential }; ticket=${ socketTicket }`,
        response_url: `https://hooks.slack.com/${ socketTicket }`,
      },
    }));
    const iterator = manager.events('relay-1', new AbortController().signal)[Symbol.asyncIterator]();
    const event = await iterator.next();
    const serialized = JSON.stringify(event.value);
    assert.doesNotMatch(serialized, new RegExp(credential));
    assert.doesNotMatch(serialized, new RegExp(socketTicket));
    assert.doesNotMatch(serialized, /response_url/);
    assert.match(serialized, /\[redacted\]/);
  });
});

test('closeAll destroys queued events before a caller can drain them', async() => {
  await withSlackRelay(async(manager, socket) => {
    socket.message(JSON.stringify({ envelope_id: 'envelope-1', type: 'events_api', payload: { text: 'queued' } }));
    const iterator = manager.events('relay-1', new AbortController().signal)[Symbol.asyncIterator]();
    manager.closeAll('vault_locked');
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });
});

test('queue overflow emits an explicit gap instead of silently dropping events', async() => {
  await withSlackRelay(async(manager, socket) => {
    for (let index = 0; index < 513; index++) {
      socket.message(JSON.stringify({ envelope_id: `envelope-${ index }`, type: 'events_api', payload: { index } }));
    }
    const iterator = manager.events('relay-1', new AbortController().signal)[Symbol.asyncIterator]();
    const event = await iterator.next();
    assert.equal(event.value?.type, 'relay.gap');
    assert.deepEqual(event.value?.payload, { reason: 'queue_overflow' });
  });
});

test('oversized frames close the provider socket', async() => {
  await withSlackRelay((_manager, socket) => {
    socket.message('x'.repeat(512 * 1024 + 1));
    assert.equal(socket.closeCode, 1009);
  });
});

test('already-aborted authority cannot open a relay', async() => {
  const controller = new AbortController();
  controller.abort();
  const manager = new DefaultVaultRelayManager();
  await assert.rejects(manager.open({
    relayId: 'relay-aborted', operation: 'slack.socket-mode', credential, abortSignal: controller.signal,
  }), /invalid_relay_request/);
});
