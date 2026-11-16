// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * E9 relays slice: the vault relay manager keeps byte-identical behaviour.
 * Every scenario below is a scripted sequence (fake sockets, fake fetch, fixed
 * clock, deterministic randomness) run once against a frozen legacy copy of
 * relays.ts (ddbe28884) and once against the module under test. The full
 * transcript — handles, thrown errors (sync vs async), emitted events with
 * sequence numbers, and every frame written to every socket — must be equal.
 * The relays carry live provider credentials, so redaction and the command
 * allow-lists are the security-relevant behaviour pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as current from '../../../../../../services/sulla-vault/src/relays';
import { SULLA_CLOUD_HOST } from '../../../../../../services/sulla-vault/src/sullaCloudRelay';
import * as legacy from '../../Support/E9Legacy/relays.legacy';
import { FakeBrowserSocket, FakeNodeSocket } from '../../Support/Vault/E9RelayFakes';

const cryptoMock = vi.hoisted(() => ({ randomUUID: vi.fn() }));

vi.mock('node:crypto', async(importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  cryptoMock.randomUUID.mockImplementation(() => actual.randomUUID());
  return { ...actual, randomUUID: cryptoMock.randomUUID };
});

// The enterprise relay constructs `ws` sockets directly (no injection point).
vi.mock('ws', async() => {
  const fakes = await import('../../Support/Vault/E9RelayFakes');
  return { default: fakes.FakeNodeSocket, WebSocket: fakes.FakeNodeSocket };
});

type RelayModule = Pick<typeof current, 'DefaultVaultRelayManager' | 'createRelayId'>;
type Manager = InstanceType<typeof current.DefaultVaultRelayManager>;

const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
const MODULES: Array<[string, RelayModule]> = [['legacy', legacy as unknown as RelayModule], ['current', current]];

function describeError(error: any): Record<string, unknown> {
  return { name: error?.constructor?.name ?? typeof error, message: String(error?.message ?? error), code: error?.code ?? null };
}

/** Calls fn and records whether it returned, threw synchronously, or rejected. */
async function attempt(fn: () => unknown): Promise<unknown> {
  let result: unknown;
  try {
    result = fn();
  } catch (error) {
    return { thrown: 'sync', ...describeError(error) };
  }
  try {
    const value = await result;
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return { thrown: 'async', ...describeError(error) };
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function consume(manager: Manager, relayId: string) {
  const controller = new AbortController();
  const events: unknown[] = [];
  const done = (async() => {
    try {
      for await (const event of manager.events(relayId, controller.signal)) events.push(event);
      events.push('ended');
    } catch (error) {
      events.push({ consumerError: describeError(error) });
    }
  })();
  return {
    events,
    stop: async() => {
      await flush();
      controller.abort();
      await done;
      return events;
    },
  };
}

function cloudFactory(sockets: FakeNodeSocket[]) {
  return (url: URL, options: any) => {
    const socket = new FakeNodeSocket(url, options);
    sockets.push(socket);
    return socket as any;
  };
}

type FetchReply = { status: number; body: string };
function installFetch(replies: FetchReply[], log: unknown[]): void {
  vi.stubGlobal('fetch', async(input: unknown, init: any = {}) => {
    log.push(['fetch', String(input), init.method ?? 'GET', init.headers ?? null, init.body ?? null, init.redirect ?? null, init.signal instanceof AbortSignal]);
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected fetch');
    return new Response(reply.body, { status: reply.status });
  });
}

// ─── Scenarios (each returns a plain-data transcript) ────────────────────────

const CLOUD_TARGET = () => `wss://${ SULLA_CLOUD_HOST }/relay/room-1?device=d1`;

async function sullaCloudLifecycle(mod: RelayModule): Promise<unknown[]> {
  const t: unknown[] = [];
  const sockets: FakeNodeSocket[] = [];
  const manager = new mod.DefaultVaultRelayManager(cloudFactory(sockets));
  const authority = new AbortController();
  const request = { relayId: 'relay-cloud', operation: 'sulla-cloud.relay' as const, credential: 'cloud-secret-token', targetUrl: CLOUD_TARGET(), abortSignal: authority.signal };
  const opening = manager.open(request);
  t.push(['sockets-before-open', sockets.length]);
  sockets[0].open();
  t.push(['open', await attempt(() => opening)]);
  t.push(['duplicate', await attempt(() => manager.open(request))]);
  const consumer = consume(manager, 'relay-cloud');
  sockets[0].emit('message', Buffer.from('{"t":"hello","auth":"cloud-secret-token"}'), false);
  sockets[0].emit('message', Buffer.from([1, 2, 3]), true);
  sockets[0].emit('message', [Buffer.from('frag-'), Buffer.from('ment')], false);
  await flush();
  const send = (command: any) => attempt(() => manager.send('relay-cloud', command));
  t.push(['send-valid', await send({ type: 'sulla-cloud.frame', payload: { data: '{"x":1}' } })]);
  t.push(['send-wrong-type', await send({ type: 'slack.ack', payload: { data: 'a' } })]);
  t.push(['send-missing-data', await send({ type: 'sulla-cloud.frame', payload: {} })]);
  t.push(['send-empty-data', await send({ type: 'sulla-cloud.frame', payload: { data: '' } })]);
  t.push(['send-array-payload', await send({ type: 'sulla-cloud.frame', payload: ['a'] })]);
  t.push(['send-too-large', await send({ type: 'sulla-cloud.frame', payload: { data: 'y'.repeat(1024 * 1024 + 1) } })]);
  sockets[0].bufferedAmount = 8 * 1024 * 1024 + 1;
  t.push(['send-backpressure', await send({ type: 'sulla-cloud.frame', payload: { data: 'z' } })]);
  sockets[0].bufferedAmount = 0;
  t.push(['send-unknown-relay', await attempt(() => manager.send('nope', { type: 'sulla-cloud.frame', payload: { data: 'z' } }))]);
  t.push(['events-unknown-relay', await attempt(() => manager.events('nope', new AbortController().signal))]);
  // An oversized frame closes the upstream with 1009 (invalid_frame).
  sockets[0].emit('message', Buffer.from('x'.repeat(3 * 1024 * 1024 + 10)), false);
  sockets[0].emit('close', 1006);
  t.push(['events', await consumer.stop()]);
  t.push(['send-after-upstream-close', await send({ type: 'sulla-cloud.frame', payload: { data: 'z' } })]);
  manager.closeAll('test_done');
  t.push(['send-after-closeAll', await send({ type: 'sulla-cloud.frame', payload: { data: 'z' } })]);
  t.push(['sockets', sockets.map(socket => socket.log)]);
  return t;
}

async function sullaCloudAuthorityAbortAndExpiry(mod: RelayModule): Promise<unknown[]> {
  const t: unknown[] = [];
  const sockets: FakeNodeSocket[] = [];
  const manager = new mod.DefaultVaultRelayManager(cloudFactory(sockets));
  const authorityA = new AbortController();
  const openA = manager.open({ relayId: 'a', operation: 'sulla-cloud.relay', credential: 'token-aaaa', targetUrl: CLOUD_TARGET(), abortSignal: authorityA.signal });
  sockets[0].open();
  t.push(['open-a', await attempt(() => openA)]);
  const consumerA = consume(manager, 'a');
  sockets[0].emit('message', Buffer.from('queued'), false);
  authorityA.abort();
  t.push(['events-a', await consumerA.stop()]);
  t.push(['send-a-after-abort', await attempt(() => manager.send('a', { type: 'sulla-cloud.frame', payload: { data: 'q' } }))]);

  const openB = manager.open({ relayId: 'b', operation: 'sulla-cloud.relay', credential: 'token-bbbb', targetUrl: CLOUD_TARGET(), abortSignal: new AbortController().signal });
  sockets[1].open();
  t.push(['open-b', await attempt(() => openB)]);
  vi.setSystemTime(T0 + 30 * 60_000 - 1);
  t.push(['send-b-before-expiry', await attempt(() => manager.send('b', { type: 'sulla-cloud.frame', payload: { data: 'q' } }))]);
  vi.setSystemTime(T0 + 30 * 60_000);
  t.push(['send-b-at-expiry', await attempt(() => manager.send('b', { type: 'sulla-cloud.frame', payload: { data: 'q' } }))]);
  t.push(['events-b-after-expiry', await attempt(() => manager.events('b', new AbortController().signal))]);
  manager.close('missing-relay', 'noop');
  manager.closeAll('done');
  t.push(['sockets', sockets.map(socket => socket.log)]);
  return t;
}

async function sullaCloudOpenFailures(mod: RelayModule): Promise<unknown[]> {
  const t: unknown[] = [];
  const base = { operation: 'sulla-cloud.relay' as const, credential: 'cloud-token', targetUrl: CLOUD_TARGET() };
  const invalid = [
    { relayId: '', abort: false, credential: 'cloud-token' },
    { relayId: 'r', abort: false, credential: '' },
    { relayId: 'r', abort: true, credential: 'cloud-token' },
  ];
  for (const entry of invalid) {
    const manager = new mod.DefaultVaultRelayManager(cloudFactory([]));
    const controller = new AbortController();
    if (entry.abort) controller.abort();
    t.push(['invalid', await attempt(() => manager.open({ ...base, relayId: entry.relayId, credential: entry.credential, abortSignal: controller.signal }))]);
  }
  const targets = [
    '', 'not a url', `ws://${ SULLA_CLOUD_HOST }/relay/x`, 'wss://evil.example/relay/x', `wss://${ SULLA_CLOUD_HOST }:8443/relay/x`,
    `wss://user:pw@${ SULLA_CLOUD_HOST }/relay/x`, `wss://${ SULLA_CLOUD_HOST }/relay/x#frag`, `wss://${ SULLA_CLOUD_HOST }/other/x`,
    `wss://${ SULLA_CLOUD_HOST }/relayx`,
  ];
  for (const targetUrl of targets) {
    const sockets: FakeNodeSocket[] = [];
    const manager = new mod.DefaultVaultRelayManager(cloudFactory(sockets));
    t.push(['target', targetUrl, await attempt(() => manager.open({ ...base, relayId: 'r', targetUrl, abortSignal: new AbortController().signal })), sockets.length]);
  }
  const handshakes: Array<[string, (socket: FakeNodeSocket) => void]> = [
    ['401', socket => socket.emit('unexpected-response', {}, { statusCode: 401, resume: () => socket.log.push(['resume']) })],
    ['403', socket => socket.emit('unexpected-response', {}, { statusCode: 403, resume: () => socket.log.push(['resume']) })],
    ['500', socket => socket.emit('unexpected-response', {}, { statusCode: 500, resume: () => socket.log.push(['resume']) })],
    ['no-status', socket => socket.emit('unexpected-response', {}, { resume: () => socket.log.push(['resume']) })],
    ['error', socket => socket.emit('error', new Error('ECONNREFUSED'))],
  ];
  for (const [label, fail] of handshakes) {
    const sockets: FakeNodeSocket[] = [];
    const manager = new mod.DefaultVaultRelayManager(cloudFactory(sockets));
    const opening = manager.open({ ...base, relayId: 'r', abortSignal: new AbortController().signal });
    fail(sockets[0]);
    t.push(['handshake', label, await attempt(() => opening)]);
    t.push(['send-after-failed-open', await attempt(() => manager.send('r', { type: 'sulla-cloud.frame', payload: { data: 'q' } }))]);
    t.push(['socket-log', sockets[0].log]);
  }
  return t;
}

async function discordLifecycle(mod: RelayModule): Promise<unknown[]> {
  const t: unknown[] = [];
  const fetchLog: unknown[] = [];
  installFetch([{ status: 200, body: JSON.stringify({ url: 'wss://gateway.discord.gg/' }) }], fetchLog);
  const manager = new mod.DefaultVaultRelayManager(cloudFactory([]));
  t.push(['open', await attempt(() => manager.open({ relayId: 'discord', operation: 'discord.gateway', credential: 'bot-token-xyz', abortSignal: new AbortController().signal }))]);
  t.push(['fetch', fetchLog]);
  const socket = FakeBrowserSocket.instances[0];
  const send = (command: any) => attempt(() => manager.send('discord', command));
  t.push(['send-before-open', await send({ type: 'discord.presence', payload: {} })]);
  socket.emitOpen();
  const consumer = consume(manager, 'discord');
  const frame = (value: unknown) => socket.emitMessage(JSON.stringify(value));
  frame({ op: 10, d: { heartbeat_interval: 41_250 } });
  frame({ op: 11 });
  frame({ op: 1 });
  frame({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-abcdef', resume_gateway_url: 'wss://us-east1.discord.gg', user: { id: '1' } } });
  frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { content: 'leak sess-abcdef and bot-token-xyz', nested: { cookie: 'c', ok: true } } });
  frame({ op: 0, s: 3, t: 5, d: {} });
  frame({ op: 'x' });
  frame({ op: 0, t: 'GUILD_CREATE' });
  t.push(['presence', await send({ type: 'discord.presence', payload: { status: 'dnd', since: 5, activities: [{ name: 'sess-abcdef' }], afk: true } })]);
  t.push(['presence-defaults', await send({ type: 'discord.presence', payload: null })]);
  t.push(['presence-bad-status', await send({ type: 'discord.presence', payload: { status: 'busy', since: '5', activities: 'x', afk: 'yes' } })]);
  t.push(['voice', await send({ type: 'discord.voice-state', payload: { guild_id: 'g1', channel_id: 'c1', self_mute: true, self_deaf: 1 } })]);
  t.push(['voice-leave', await send({ type: 'discord.voice-state', payload: { guild_id: 'g1', channel_id: 7 } })]);
  t.push(['voice-missing-guild', await send({ type: 'discord.voice-state', payload: { channel_id: 'c1' } })]);
  t.push(['unknown', await send({ type: 'discord.message', payload: {} })]);
  t.push(['too-large', await send({ type: 'discord.presence', payload: { x: 'a'.repeat(64 * 1024) } })]);
  frame({ op: 11 });
  frame({ op: 1 });
  frame({ op: 10, d: { heartbeat_interval: 30_000 } });
  frame({ op: 10, d: { heartbeat_interval: 500 } });
  frame({ op: 7 });
  frame({ op: 9, d: false });
  t.push(['send-after-close', await send({ type: 'discord.presence', payload: {} })]);
  t.push(['events', await consumer.stop()]);
  manager.closeAll('done');
  t.push(['socket', socket.log]);
  return t;
}

async function discordFailures(mod: RelayModule): Promise<unknown[]> {
  const t: unknown[] = [];
  const replies: FetchReply[] = [
    { status: 401, body: JSON.stringify({ url: 'wss://gateway.discord.gg' }) },
    { status: 200, body: JSON.stringify({}) },
    { status: 200, body: JSON.stringify({ url: 'wss://evil.example' }) },
    { status: 200, body: JSON.stringify({ url: 'ws://gateway.discord.gg' }) },
    { status: 200, body: JSON.stringify({ url: 'wss://a:b@gateway.discord.gg' }) },
    { status: 200, body: JSON.stringify({ url: 'wss://edge.discord.gg/path' }) },
  ];
  for (const reply of replies) {
    FakeBrowserSocket.reset();
    installFetch([reply], []);
    const manager = new mod.DefaultVaultRelayManager(cloudFactory([]));
    t.push(['open', await attempt(() => manager.open({ relayId: 'd', operation: 'discord.gateway', credential: 'bot-token', abortSignal: new AbortController().signal })), FakeBrowserSocket.instances.map(s => s.log)]);
    manager.closeAll('done');
  }
  // A READY frame with a non-Discord resume URL is an invalid frame.
  FakeBrowserSocket.reset();
  installFetch([{ status: 200, body: JSON.stringify({ url: 'wss://gateway.discord.gg' }) }], []);
  const manager = new mod.DefaultVaultRelayManager(cloudFactory([]));
  await manager.open({ relayId: 'd', operation: 'discord.gateway', credential: 'bot-token', abortSignal: new AbortController().signal });
  const socket = FakeBrowserSocket.instances[0];
  socket.emitOpen();
  socket.emitMessage(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 's1', resume_gateway_url: 'wss://evil.example' } }));
  const consumer = consume(manager, 'd');
  t.push(['events', await consumer.stop()]);
  manager.closeAll('done');
  t.push(['socket', socket.log]);
  return t;
}

const GATEWAY = { gatewayUrl: 'https://gateway.example.test:8443/base', gatewayAddress: { address: '203.0.113.10', family: 4 as const } };

async function enterpriseLifecycle(mod: RelayModule): Promise<unknown[]> {
  const t: unknown[] = [];
  const manager = new mod.DefaultVaultRelayManager(cloudFactory([]));
  const opening = manager.open({ relayId: 'ent', operation: 'enterprise.gateway', credential: 'ent-api-key-123', ...GATEWAY, abortSignal: new AbortController().signal });
  const lobby = FakeNodeSocket.last();
  lobby.open();
  t.push(['open', await attempt(() => opening)]);
  const consumer = consume(manager, 'ent');
  const send = (command: any) => attempt(() => manager.send('ent', command));
  lobby.emit('message', Buffer.from(JSON.stringify({ event_type: 'call', _msg_id: 'm1', note: 'ent-api-key-123', secret: 's' })));
  lobby.emit('message', Buffer.from('{bad'));
  lobby.emit('message', Buffer.from(JSON.stringify({ event_type: 'no-ack', _msg_id: '' })));
  t.push(['ack', await send({ type: 'gateway.ack', payload: { _msg_id: 'm1' } })]);
  t.push(['ack-again', await send({ type: 'gateway.ack', payload: { _msg_id: 'm1' } })]);
  t.push(['ack-missing', await send({ type: 'gateway.ack', payload: null })]);
  t.push(['capabilities', await send({ type: 'gateway.capabilities' })]);
  t.push(['session-bad-id', await send({ type: 'gateway.session.open', payload: { sessionId: 'bad id!' } })]);
  t.push(['unknown-no-session', await send({ type: 'gateway.unknown', payload: {} })]);
  t.push(['unknown-with-session', await send({ type: 'gateway.unknown', payload: { sessionId: 'sess_1' } })]);
  const sessionOpen = manager.send('ent', { type: 'gateway.session.open', payload: { sessionId: 'sess_1' } });
  const session = FakeNodeSocket.last();
  session.open();
  t.push(['session-open', await attempt(() => sessionOpen)]);
  session.emit('message', Buffer.from(JSON.stringify({ event_type: 'transcript', _msg_id: 'm2', url: 'wss://gateway.example.test:8443/ws/listener/sess_1?apiKey=ent-api-key-123' })));
  t.push(['session-ack', await send({ type: 'gateway.ack', payload: { _msg_id: 'm2' } })]);
  t.push(['session-close-wrong', await send({ type: 'gateway.session.close', payload: { sessionId: 'sess_2' } })]);
  t.push(['session-close', await send({ type: 'gateway.session.close', payload: { sessionId: 'sess_1' } })]);
  const audioOpen = manager.send('ent', { type: 'gateway.audio.open', payload: { sessionId: 'sess_1' } });
  const audio = FakeNodeSocket.last();
  audio.open();
  t.push(['audio-open', await attempt(() => audioOpen)]);
  const chunk = (payload: Record<string, unknown>) => send({ type: 'gateway.audio.chunk', payload: { sessionId: 'sess_1', ...payload } });
  t.push(['chunk-0', await chunk({ data: 'AAEC' })]);
  t.push(['chunk-3', await chunk({ channel: 3, data: 'AAEC' })]);
  t.push(['chunk-256', await chunk({ channel: 256, data: 'AAEC' })]);
  t.push(['chunk-neg', await chunk({ channel: -1, data: 'AAEC' })]);
  t.push(['chunk-frac', await chunk({ channel: 1.5, data: 'AAEC' })]);
  t.push(['chunk-not-string', await chunk({ data: 5 })]);
  t.push(['chunk-not-base64', await chunk({ data: 'not base64!' })]);
  t.push(['chunk-noncanonical', await chunk({ data: 'AAF=' })]);
  t.push(['chunk-oversize-audio', await chunk({ data: Buffer.alloc(64 * 1024 + 1).toString('base64') })]);
  t.push(['chunk-oversize-command', await chunk({ data: Buffer.alloc(70 * 1024).toString('base64') })]);
  t.push(['chunk-wrong-session', await send({ type: 'gateway.audio.chunk', payload: { sessionId: 'sess_9', data: 'AAEC' } })]);
  audio.bufferedAmount = 256 * 1024 + 1;
  t.push(['chunk-backpressure', await chunk({ data: 'AAEC' })]);
  audio.bufferedAmount = 0;
  audio.emit('message', Buffer.from(JSON.stringify({ event_type: 'audio-meta' })));
  t.push(['audio-close-wrong', await send({ type: 'gateway.audio.close', payload: { sessionId: 'sess_2' } })]);
  t.push(['audio-close', await send({ type: 'gateway.audio.close', payload: { sessionId: 'sess_1' } })]);
  t.push(['chunk-after-close', await chunk({ data: 'AAEC' })]);
  lobby.emit('message', Buffer.alloc(512 * 1024 + 1, 0x20));
  t.push(['capabilities-after-lobby-close', await send({ type: 'gateway.capabilities' })]);
  t.push(['events', await consumer.stop()]);
  manager.closeAll('done');
  t.push(['sockets', FakeNodeSocket.instances.map(socket => socket.log)]);
  return t;
}

async function enterpriseFailures(mod: RelayModule): Promise<unknown[]> {
  const t: unknown[] = [];
  const cases: Array<[string, Record<string, unknown>]> = [
    ['http', { gatewayUrl: 'http://gateway.example.test', gatewayAddress: GATEWAY.gatewayAddress }],
    ['credentials', { gatewayUrl: 'https://u:p@gateway.example.test', gatewayAddress: GATEWAY.gatewayAddress }],
    ['search', { gatewayUrl: 'https://gateway.example.test/?q=1', gatewayAddress: GATEWAY.gatewayAddress }],
    ['hash', { gatewayUrl: 'https://gateway.example.test/#h', gatewayAddress: GATEWAY.gatewayAddress }],
    ['no-address', { gatewayUrl: 'https://gateway.example.test' }],
    ['no-url', { gatewayAddress: GATEWAY.gatewayAddress }],
  ];
  for (const [label, extra] of cases) {
    FakeNodeSocket.reset();
    const manager = new mod.DefaultVaultRelayManager(cloudFactory([]));
    t.push([label, await attempt(() => manager.open({ relayId: 'e', operation: 'enterprise.gateway', credential: 'k-123', abortSignal: new AbortController().signal, ...extra } as any)), FakeNodeSocket.instances.length]);
  }
  FakeNodeSocket.reset();
  const manager = new mod.DefaultVaultRelayManager(cloudFactory([]));
  const opening = manager.open({ relayId: 'e', operation: 'enterprise.gateway', credential: 'k-123', ...GATEWAY, abortSignal: new AbortController().signal });
  FakeNodeSocket.last().emit('error', new Error('ECONNRESET'));
  t.push(['lobby-error', await attempt(() => opening)]);
  t.push(['sockets', FakeNodeSocket.instances.map(socket => socket.log)]);
  t.push(['reopen-after-failure', await attempt(async() => {
    const again = manager.open({ relayId: 'e', operation: 'enterprise.gateway', credential: 'k-123', ...GATEWAY, abortSignal: new AbortController().signal });
    FakeNodeSocket.last().open();
    return again;
  })]);
  manager.closeAll('done');
  return t;
}

// ─── Spec ────────────────────────────────────────────────────────────────────

async function runBoth(scenario: (mod: RelayModule) => Promise<unknown[]>): Promise<[unknown[], unknown[]]> {
  const results: unknown[][] = [];
  for (const [, mod] of MODULES) {
    vi.setSystemTime(T0);
    FakeBrowserSocket.reset();
    FakeNodeSocket.reset();
    results.push(await scenario(mod));
  }
  return [results[0], results[1]];
}

describe('E9 relays: legacy vs current behave identically', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    vi.stubGlobal('WebSocket', FakeBrowserSocket);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(Math.random).mockRestore();
  });

  it('createRelayId uses randomUUID verbatim', () => {
    // risk: relay ids are capability handles; they must stay unguessable UUIDs.
    for (const [, mod] of MODULES) {
      cryptoMock.randomUUID.mockReturnValueOnce('11111111-2222-4333-8444-555555555555');
      expect(mod.createRelayId()).toBe('11111111-2222-4333-8444-555555555555');
    }
    const ids = MODULES.map(([, mod]) => mod.createRelayId());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('Sulla Cloud relay: open, frames, send allow-list, upstream close', async() => {
    // risk: credential leak — the Bearer token must be redacted out of relayed frames.
    const [old, next] = await runBoth(sullaCloudLifecycle);
    expect(next).toEqual(old);
    expect(JSON.stringify((next as any[]).find(entry => entry[0] === 'events'))).not.toContain('cloud-secret-token');
    expect(next[1]).toEqual(['open', { ok: { relayId: 'relay-cloud', expiresAt: T0 + 30 * 60_000 } }]);
  });

  it('Sulla Cloud relay: authority abort and session expiry', async() => {
    // risk: authorization — sessions must die when the authority locks or the TTL passes.
    const [old, next] = await runBoth(sullaCloudAuthorityAbortAndExpiry);
    expect(next).toEqual(old);
  });

  it('Sulla Cloud relay: invalid requests, destination checks and failed handshakes', async() => {
    // risk: SSRF / credential exfiltration — the token must only ever go to the fixed Sulla Cloud host.
    const [old, next] = await runBoth(sullaCloudOpenFailures);
    expect(next).toEqual(old);
  });

  it('Discord gateway relay: identify, heartbeat, resume and command allow-list', async() => {
    // risk: credential leak — the bot token and session id never reach relay events.
    const [old, next] = await runBoth(discordLifecycle);
    expect(next).toEqual(old);
    expect(JSON.stringify((next as any[]).find(entry => entry[0] === 'events'))).not.toContain('bot-token-xyz');
  });

  it('Discord gateway relay: bootstrap failures and resume URL checks', async() => {
    // risk: SSRF — gateway and resume URLs must be Discord wss hosts.
    const [old, next] = await runBoth(discordFailures);
    expect(next).toEqual(old);
  });

  it('Enterprise gateway relay: lobby, session, audio and ack routing', async() => {
    // risk: credential leak + audio integrity — api key redacted, chunks validated byte-exactly.
    const [old, next] = await runBoth(enterpriseLifecycle);
    expect(next).toEqual(old);
    expect(JSON.stringify((next as any[]).find(entry => entry[0] === 'events'))).not.toContain('ent-api-key-123');
  });

  it('Enterprise gateway relay: destination checks and lobby connect failure', async() => {
    // risk: SSRF — gateway must be a clean https origin pinned to an authority-checked address.
    const [old, next] = await runBoth(enterpriseFailures);
    expect(next).toEqual(old);
  });
});
