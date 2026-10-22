import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import test from 'node:test';

import { DEFAULT_AGENT_POLICY, encryptItem, validateVaultItemProxy, type VaultItemPlaintext } from '@sulla/vault-crypto';

import { LocalVaultAuthority } from './localAuthority.js';
import type { BrokerExecuteRequest } from './contracts.js';
import type { VaultConfig } from './config.js';

const owner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const brokerToken = 'synthetic-broker-identity-'.repeat(3);
const item = (): VaultItemPlaintext => ({
  type: 'apiKey', name: 'Synthetic Cloudflare', password: 'synthetic-"key-never-returned', username: 'synthetic@example.invalid',
  agentPolicy: { ...DEFAULT_AGENT_POLICY, mode: 'agents', level: 'autofill', agents: ['worker'], sites: ['api.cloudflare.com'] },
  proxy: { hosts: ['api.cloudflare.com'], rules: [
    { source: 'password', target: 'header', name: 'X-Auth-Key', scheme: 'raw' },
    { source: 'username', target: 'header', name: 'X-Auth-Email', scheme: 'raw' },
  ] },
});
const request = (): BrokerExecuteRequest => ({
  claims: { sub: owner, agent_id: 'worker', pod_id: 'synthetic', credential_scope: { item_id: id } },
  operation: 'item.http', ref: { itemId: id }, url: 'https://api.cloudflare.com/client/v4/user', method: 'GET', injections: [],
});

async function harness(plaintext = item()) {
  const userKey = randomBytes(32);
  const encrypted = await encryptItem(JSON.stringify(plaintext), userKey, { itemId: id, ownerId: owner });
  const audit: unknown[] = [];
  const row = { id, owner_user_id: owner, collection_id: null, ciphertext: encrypted.ciphertext,
    encrypted_item_key: encrypted.encryptedItemKey, agent_policy: plaintext.agentPolicy, revision: 1 };
  const db = { query: async(sql: string, args: unknown[]) => {
    if (sql.includes('INSERT INTO audit_log')) { audit.push(args); return { rows: [], rowCount: 1 }; }
    return { rows: [row], rowCount: 1 };
  } };
  const authority = new LocalVaultAuthority(db as any, {
    mode: 'server', brokerServiceId: 'synthetic-broker', brokerServiceToken: brokerToken,
  } as VaultConfig);
  (authority as any).keys = { userId: owner, userKey };
  // Mock only DNS/target pinning, never bypass policy, decryption, injection, send, or redaction.
  (authority as any).validateTarget = async(raw: string) => {
    const url = new URL(raw);
    assert.equal(url.protocol, 'https:');
    return Object.assign(url, { pinnedAddress: '104.16.132.229', pinnedFamily: 4 });
  };
  return { authority, audit, row, execute: (input = request()) => authority.execute(input, 'synthetic-broker', brokerToken) };
}

test('item.http keeps owner-declared credentials behind policy and redacts the final HTTPS response', async(t) => {
  let captured: any;
  let calls = 0;
  t.mock.method(https, 'request', ((options: any, callback: any) => {
    calls++; captured = options;
    const req = new EventEmitter() as any;
    req.write = () => {};
    req.destroy = (error: Error) => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter() as any;
      response.statusCode = 200; response.headers = { 'x-echo': item().password, 'set-cookie': 'blocked' };
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ echoed: item().password, email: item().username })));
      response.emit('end');
    });
    return req;
  }) as any);
  const allowed = await harness();
  const input = request(); input.headers = { Authorization: 'caller-controlled', 'x-auth-key': 'forged', 'X-Auth-Email': 'forged' };
  const result = await allowed.execute(input);
  assert.equal(captured.hostname, 'api.cloudflare.com');
  assert.equal(captured.headers['X-Auth-Key'], item().password);
  assert.equal(captured.headers['X-Auth-Email'], item().username);
  assert.equal(captured.headers.Authorization, undefined);
  assert.equal(captured.headers['x-auth-key'], undefined);
  assert.equal(result.headers['set-cookie'], undefined);
  for (const value of [item().password!, item().username!, 'caller-controlled', 'forged']) {
    assert.ok(!JSON.stringify(result).includes(value));
    assert.ok(!JSON.stringify(allowed.audit).includes(value));
  }
  assert.ok(JSON.stringify(allowed.audit).includes(id));
  assert.ok(JSON.stringify(allowed.audit).includes('api.cloudflare.com'));
  const listed = await allowed.authority.listBrokerItems(input.claims, 'synthetic-broker', brokerToken);
  assert.equal(listed.items[0].id, id);
  assert.ok(!JSON.stringify(listed).includes('source'));
  assert.ok(!JSON.stringify(listed).includes(item().password!));

  const cases: Array<[string, (p: VaultItemPlaintext, r: BrokerExecuteRequest) => void]> = [
    ['owner-only', p => { p.agentPolicy.mode = 'only_me'; }],
    ['wrong agent', p => { p.agentPolicy.agents = ['another']; }],
    ['expired', p => { p.agentPolicy.expiresAt = '2000-01-01T00:00:00Z'; }],
    ['metadata only', p => { p.agentPolicy.level = 'metadata'; }],
    ['host outside usage', p => { p.proxy!.hosts = ['other.example.com']; }],
    ['host outside policy', p => { p.agentPolicy.sites = ['other.example.com']; }],
    ['missing rules', p => { delete p.proxy; }],
    ['other operation', (_p, r) => { r.operation = 'github.api'; r.ref.integrationId = 'github'; r.ref.accountId = 'default'; r.claims.credential_scope = { integration_id: 'github', account_id: 'default' }; }],
    ['scope mismatch', (_p, r) => { r.claims.credential_scope!.item_id = owner; }],
    ['caller injection', (_p, r) => { r.injections = [{ field: 'password', name: 'authorization', target: 'header' }]; }],
    ['streaming', (_p, r) => { r.responseType = 'stream'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async() => {
    const p = item(); const r = request(); mutate(p, r); const h = await harness(p);
    const before = calls;
    await assert.rejects(h.execute(r));
    assert.equal(calls, before);
  });
  await t.test('approval and lock remain enforced', async() => {
    const p = item(); p.agentPolicy.askFirst = true; const h = await harness(p);
    await assert.rejects(h.execute(), (error: any) => error.code === 'approval_required');
    (h.authority as any).keys = null;
    await assert.rejects(h.execute(), (error: any) => error.code === 'vault_locked');
  });
  await t.test('proxy validator rejects broker-owned headers and absent custom sources', () => {
    for (const name of ['host', 'cookie', 'content-length', 'connection', 'transfer-encoding']) {
      const p = item(); p.proxy!.rules[0].name = name;
      assert.equal(validateVaultItemProxy(p).ok, false);
    }
    const p = item(); p.proxy!.rules[0].source = 'custom:missing';
    assert.equal(validateVaultItemProxy(p).ok, false);
  });
});
