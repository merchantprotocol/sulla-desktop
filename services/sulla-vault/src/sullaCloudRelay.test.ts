import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import NodeWebSocket, { WebSocketServer } from 'ws';
import { encryptItem } from '@sulla/vault-crypto';

import { LocalVaultAuthority, LocalVaultError } from './localAuthority.js';
import { DefaultVaultRelayManager, type VaultRelayEvent, type VaultRelayManager, type VaultRelayOpenRequest } from './relays.js';
import {
  parseSullaCloudRefresh,
  SULLA_CLOUD_REFRESH_URL,
  sullaCloudRelayUrl,
  sullaCloudTokenNeedsRefresh,
  validateSullaCloudRelayParams,
} from './sullaCloudRelay.js';

import type { VaultConfig } from './config.js';

const ROOM = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const DEVICE = '22222222-2222-4222-8222-bbbbbbbbbbbb';

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${ part({ alg: 'HS256', typ: 'JWT' }) }.${ part(payload) }.synthetic-signature`;
}
const now = () => Math.floor(Date.now() / 1000);
const freshToken = (sub = ROOM) => jwt({ sub, iat: now(), exp: now() + 900 });
const expiredToken = (sub = ROOM) => jwt({ sub, iat: now() - 1000, exp: now() - 100 });

// ── Pure binding helpers ─────────────────────────────────────────────

test('relay params accept only bounded opaque routing ids', () => {
  assert.deepEqual(validateSullaCloudRelayParams({ room: ROOM, deviceId: DEVICE }), { room: ROOM, deviceId: DEVICE });
  for (const bad of [
    undefined, null, [], {}, { room: ROOM }, { room: '../x', deviceId: DEVICE }, { room: ROOM, deviceId: 'a b' },
    { room: ROOM, deviceId: DEVICE, token: 'x' }, { room: 'x'.repeat(129), deviceId: DEVICE },
  ]) {
    assert.throws(() => validateSullaCloudRelayParams(bad), /relay_params_invalid/);
  }
});

test('relay URL binds room to the token subject and never carries the token', () => {
  const token = freshToken();
  const url = sullaCloudRelayUrl({ room: ROOM, deviceId: DEVICE }, token);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.hostname, 'sulla-workers.merchantprotocol.workers.dev');
  assert.equal(url.pathname, `/relay/${ ROOM }`);
  assert.equal(url.searchParams.get('role'), 'desktop');
  assert.equal(url.searchParams.get('deviceId'), DEVICE);
  assert.equal(url.searchParams.has('token'), false);
  assert.doesNotMatch(url.toString(), /synthetic-signature/);
  assert.throws(() => sullaCloudRelayUrl({ room: 'someone-else', deviceId: DEVICE }, token), /relay_room_denied/);
  assert.throws(() => sullaCloudRelayUrl({ room: ROOM, deviceId: DEVICE }, 'not-a-jwt'), /relay_room_denied/);
});

test('refresh decision fails closed on missing, malformed, near-expiry tokens', () => {
  assert.equal(sullaCloudTokenNeedsRefresh(freshToken()), false);
  assert.equal(sullaCloudTokenNeedsRefresh(expiredToken()), true);
  assert.equal(sullaCloudTokenNeedsRefresh(jwt({ sub: ROOM, exp: now() + 60 })), true);
  assert.equal(sullaCloudTokenNeedsRefresh(jwt({ sub: ROOM })), true);
  assert.equal(sullaCloudTokenNeedsRefresh('garbage'), true);
  assert.equal(sullaCloudTokenNeedsRefresh(undefined), true);
});

test('refresh response parser requires a bounded access token', () => {
  assert.deepEqual(parseSullaCloudRefresh({ accessToken: 'a', refreshToken: 'r' }), { accessToken: 'a', refreshToken: 'r' });
  assert.deepEqual(parseSullaCloudRefresh({ accessToken: 'a' }), { accessToken: 'a' });
  for (const bad of [null, [], {}, { accessToken: '' }, { accessToken: 1 }, { accessToken: 'a', refreshToken: '' }, { accessToken: 'x'.repeat(70_000) }]) {
    assert.throws(() => parseSullaCloudRefresh(bad), /refresh_response_invalid/);
  }
});

// ── Relay session over a real local WebSocket server ────────────────

async function withUpstream(
  onConnection: (socket: NodeWebSocket, headers: Record<string, string | string[] | undefined>, url: string) => void,
  run: (manager: DefaultVaultRelayManager, seen: { target?: URL }) => Promise<void>,
  verifyClient?: (info: { req: { headers: Record<string, unknown> } }, done: (ok: boolean, code?: number) => void) => void,
): Promise<void> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', ...(verifyClient ? { verifyClient } : {}) });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  server.on('connection', (socket, request) => onConnection(socket, request.headers, request.url ?? ''));
  const seen: { target?: URL } = {};
  const manager = new DefaultVaultRelayManager((target, options) => {
    seen.target = target;
    return new NodeWebSocket(`ws://127.0.0.1:${ port }${ target.pathname }${ target.search }`, options);
  });
  try {
    await run(manager, seen);
  } finally {
    manager.closeAll('test_done');
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function collect(events: AsyncIterable<VaultRelayEvent>, count: number): Promise<VaultRelayEvent[]> {
  const output: VaultRelayEvent[] = [];
  for await (const event of events) {
    output.push(event);
    if (output.length >= count) break;
  }
  return output;
}

test('sulla-cloud relay authenticates by header, passes frames both ways, and redacts the credential', async() => {
  const credential = freshToken();
  const target = sullaCloudRelayUrl({ room: ROOM, deviceId: DEVICE }, credential).toString();
  let upstreamSocket: NodeWebSocket | undefined;
  const received: string[] = [];
  let seenAuth: unknown;
  let seenUrl = '';
  await withUpstream((socket, headers, url) => {
    upstreamSocket = socket;
    seenAuth = headers.authorization;
    seenUrl = url;
    socket.on('message', data => received.push(String(data)));
    socket.send(JSON.stringify({ type: 'chat', requestId: 'r1' }));
    socket.send(`{"type":"echo","leak":"${ credential }"}`);
  }, async(manager, seen) => {
    const abort = new AbortController();
    await manager.open({
      relayId: 'relay-sc-1', operation: 'sulla-cloud.relay', credential, targetUrl: target, abortSignal: abort.signal,
    } as VaultRelayOpenRequest);
    assert.equal(seen.target?.hostname, 'sulla-workers.merchantprotocol.workers.dev');
    assert.equal(seenAuth, `Bearer ${ credential }`);
    assert.doesNotMatch(seenUrl, /token=|synthetic-signature/);
    const events = await collect(manager.events('relay-sc-1', abort.signal), 2);
    assert.equal(events[0].type, 'sulla-cloud.frame');
    assert.deepEqual(JSON.parse((events[0].payload as { data: string }).data), { type: 'chat', requestId: 'r1' });
    assert.doesNotMatch(JSON.stringify(events), /synthetic-signature/);
    await manager.send('relay-sc-1', { type: 'sulla-cloud.frame', payload: { data: '{"type":"ping"}' } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(received, ['{"type":"ping"}']);
    assert.throws(() => manager.send('relay-sc-1', { type: 'slack.ack', payload: {} }), /relay_command_denied/);
    assert.throws(() => manager.send('relay-sc-1', { type: 'sulla-cloud.frame', payload: { data: 1 } }), /relay_command_invalid/);
    assert.throws(
      () => manager.send('relay-sc-1', { type: 'sulla-cloud.frame', payload: { data: 'x'.repeat(1024 * 1024 + 1) } }),
      /relay_command_invalid/,
    );
    assert.ok(upstreamSocket);
  });
});

test('upstream close is delivered as relay.closed and then ends the stream', async() => {
  const credential = freshToken();
  const target = sullaCloudRelayUrl({ room: ROOM, deviceId: DEVICE }, credential).toString();
  await withUpstream(socket => {
    socket.send('{"type":"last"}');
    setTimeout(() => socket.close(4001, 'bye'), 20);
  }, async(manager) => {
    const abort = new AbortController();
    await manager.open({ relayId: 'relay-sc-2', operation: 'sulla-cloud.relay', credential, targetUrl: target, abortSignal: abort.signal });
    const events: VaultRelayEvent[] = [];
    for await (const event of manager.events('relay-sc-2', abort.signal)) events.push(event);
    assert.deepEqual(events.map(event => event.type), ['sulla-cloud.frame', 'relay.closed']);
    assert.equal((events[1].payload as { code: number }).code, 4001);
    assert.throws(() => manager.send('relay-sc-2', { type: 'sulla-cloud.frame', payload: { data: '{}' } }), /relay_not_connected/);
  });
});

test('handshake 401 surfaces relay_unauthorized and a foreign host is denied before connecting', async() => {
  const credential = freshToken();
  const target = sullaCloudRelayUrl({ room: ROOM, deviceId: DEVICE }, credential).toString();
  await withUpstream(() => undefined, async(manager) => {
    await assert.rejects(
      manager.open({ relayId: 'relay-sc-3', operation: 'sulla-cloud.relay', credential, targetUrl: target, abortSignal: new AbortController().signal }),
      /relay_unauthorized/,
    );
    await assert.rejects(
      manager.open({
        relayId: 'relay-sc-4', operation: 'sulla-cloud.relay', credential,
        targetUrl: `wss://evil.example/relay/${ ROOM }`, abortSignal: new AbortController().signal,
      }),
      /relay_destination_denied/,
    );
  }, (_info, done) => done(false, 401));
});

// ── Authority binding: refresh + persistence stay inside the vault ──

const TOKEN = {
  bootstrap: 'bootstrap_' + 'a'.repeat(64), control: 'control_' + 'b'.repeat(64), approval: 'approval_' + 'c'.repeat(64),
  broker: 'broker_' + 'd'.repeat(64), files: 'files_' + 'e'.repeat(64),
};
const config: VaultConfig = {
  mode: 'desktop', port: 8787, databaseUrl: 'postgresql://synthetic/unused', jwtSecret: 'j'.repeat(64), extensionOrigins: [],
  bootstrapServiceId: 'sulla-desktop-bootstrap', bootstrapServiceToken: TOKEN.bootstrap,
  controlServiceId: 'sulla-desktop-control', controlServiceToken: TOKEN.control,
  approvalServiceId: 'sulla-desktop-approval', approvalServiceToken: TOKEN.approval,
  brokerServiceId: 'sulla-tools', brokerServiceToken: TOKEN.broker,
  filesServiceId: 'sulla-files', filesServiceToken: TOKEN.files,
  humanUiOrigin: 'https://127.0.0.1:30135', legacyDatabaseUrl: 'postgresql://synthetic/unused',
};
const ACTOR = '33333333-3333-4333-8333-cccccccccccc';
const ITEM = '44444444-4444-4444-8444-dddddddddddd';
const POLICY = { mode: 'agents', level: 'autofill', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false };

async function authorityHarness(properties: Record<string, string>) {
  const userKey = randomBytes(32);
  const plaintext = { type: 'apiKey', name: 'sulla-cloud (synthetic)', agentPolicy: POLICY,
    integration: { integrationId: 'sulla-cloud', accountId: ROOM, properties } };
  const encrypted = await encryptItem(JSON.stringify(plaintext), userKey, { itemId: ITEM, ownerId: ACTOR });
  const item = { id: ITEM, owner_user_id: ACTOR, collection_id: null, ciphertext: encrypted.ciphertext,
    encrypted_item_key: encrypted.encryptedItemKey, agent_policy: POLICY, revision: 3 };
  const queries: { sql: string; params?: unknown[] }[] = [];
  const query = async(sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.startsWith('UPDATE items SET ciphertext=')) return { rowCount: 1, rows: [{ revision: 4 }] };
    return { rowCount: 0, rows: [] };
  };
  const db = { query, connect: async() => ({ query, release() {} }) } as any;
  const opened: VaultRelayOpenRequest[] = [];
  const relayManager: VaultRelayManager = {
    open: async(request) => { opened.push(request); return { relayId: request.relayId, expiresAt: Date.now() + 1000 } },
    events: () => (async function * () {})(),
    send: async() => undefined,
    close: () => undefined,
    closeAll: () => undefined,
  };
  const authority = new LocalVaultAuthority(db, config, relayManager);
  (authority as any).keys = { userId: ACTOR, publicKey: '', userKey, privateKey: randomBytes(32) };
  (authority as any).generation = 1;
  (authority as any).loadBrokerItem = async() => item;
  (authority as any).validateTarget = async(raw: string) => Object.assign(new URL(raw), { pinnedAddress: '93.184.216.34', pinnedFamily: 4 });
  const sends: { url: string; body: unknown }[] = [];
  let refreshResponse: { status: number; body: unknown } = { status: 200, body: {} };
  (authority as any).send = async(url: URL, _method: string, _headers: unknown, body: unknown) => {
    sends.push({ url: url.toString(), body });
    return { status: refreshResponse.status, headers: {}, body: refreshResponse.body };
  };
  const input = (overrides: Record<string, unknown> = {}): any => ({
    claims: { sub: ACTOR, agent_id: 'sulla', pod_id: 'desktop-relay', credential_scope: { integration_id: 'sulla-cloud', account_id: ROOM } },
    operation: 'sulla-cloud.relay', ref: { integrationId: 'sulla-cloud', accountId: ROOM },
    params: { room: ROOM, deviceId: DEVICE }, ...overrides,
  });
  return {
    authority, opened, sends, queries, input,
    setRefresh: (value: { status: number; body: unknown }) => { refreshResponse = value },
  };
}

test('authority opens the relay with a fresh token without refreshing', async() => {
  const access = freshToken();
  const h = await authorityHarness({ access_token: access, refresh_token: 'synthetic-refresh' });
  const handle = await h.authority.createRelay(h.input(), 'sulla-tools', TOKEN.broker);
  assert.ok(handle.relayId);
  assert.equal(h.sends.length, 0);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].credential, access);
  assert.equal(new URL(h.opened[0].targetUrl!).pathname, `/relay/${ ROOM }`);
  assert.doesNotMatch(h.opened[0].targetUrl!, /synthetic-signature/);
  assert.doesNotMatch(JSON.stringify(handle), /synthetic-signature|synthetic-refresh/);
});

test('authority refreshes an expired token, persists the rotation, and never audits secrets', async() => {
  const nextAccess = freshToken();
  const h = await authorityHarness({ access_token: expiredToken(), refresh_token: 'synthetic-refresh' });
  h.setRefresh({ status: 200, body: { accessToken: nextAccess, refreshToken: 'synthetic-next-refresh' } });
  const handle = await h.authority.createRelay(h.input(), 'sulla-tools', TOKEN.broker);
  assert.deepEqual(h.sends, [{ url: SULLA_CLOUD_REFRESH_URL, body: { refreshToken: 'synthetic-refresh' } }]);
  assert.equal(h.opened[0].credential, nextAccess);
  const sqls = h.queries.map(q => q.sql);
  assert.ok(sqls.some(sql => sql.startsWith('UPDATE items SET ciphertext=')));
  assert.ok(sqls.includes('COMMIT'));
  const audits = h.queries.filter(q => q.sql.includes('INSERT INTO audit_log'));
  assert.equal(audits.length, 2);
  assert.doesNotMatch(JSON.stringify(audits), /synthetic-(?:refresh|next-refresh|signature)/);
  assert.doesNotMatch(JSON.stringify(handle), /synthetic/);
});

test('authority fails closed: expired session, room mismatch, wrong integration, missing params', async() => {
  const expired = await authorityHarness({ access_token: expiredToken(), refresh_token: 'synthetic-refresh' });
  expired.setRefresh({ status: 401, body: { error: 'Invalid refresh token.' } });
  await assert.rejects(expired.authority.createRelay(expired.input(), 'sulla-tools', TOKEN.broker),
    (error: unknown) => error instanceof LocalVaultError && error.code === 'upstream_failed' && error.status === 401);
  assert.equal(expired.opened.length, 0);

  const noRefresh = await authorityHarness({ access_token: expiredToken() });
  await assert.rejects(noRefresh.authority.createRelay(noRefresh.input(), 'sulla-tools', TOKEN.broker),
    (error: unknown) => error instanceof LocalVaultError && error.code === 'credential_field_missing');

  const mismatch = await authorityHarness({ access_token: freshToken('another-user') });
  await assert.rejects(mismatch.authority.createRelay(mismatch.input(), 'sulla-tools', TOKEN.broker),
    (error: unknown) => error instanceof LocalVaultError && error.code === 'policy_denied');
  assert.equal(mismatch.opened.length, 0);

  const h = await authorityHarness({ access_token: freshToken() });
  await assert.rejects(h.authority.createRelay(h.input({ ref: { integrationId: 'slack', accountId: ROOM } }), 'sulla-tools', TOKEN.broker),
    (error: unknown) => error instanceof LocalVaultError && error.code === 'policy_denied');
  await assert.rejects(h.authority.createRelay(h.input({ params: undefined }), 'sulla-tools', TOKEN.broker),
    (error: unknown) => error instanceof LocalVaultError && error.code === 'invalid_operation');
  await assert.rejects(h.authority.createRelay(h.input(), 'sulla-tools', 'wrong-token'),
    (error: unknown) => error instanceof LocalVaultError && error.code === 'invalid_service_identity');
  assert.equal(h.opened.length, 0);
});
