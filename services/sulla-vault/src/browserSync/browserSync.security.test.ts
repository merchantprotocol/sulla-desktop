// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// The vault origin's server path, against a real Postgres (synthetic data only):
// 1. the Passwords sync v3 known-answer fixture the browser wrote goes in
//    through /cloud-vault-sync and comes back out verifiable and decryptable,
//    and Postgres holds none of its plaintext;
// 2. a member without access to a collection never receives its records.
// Runs when SULLA_VAULT_TEST_DATABASE_URL names a disposable database.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';

import { decryptItemText } from '@sulla/vault-crypto';

import { createApp } from '../app.js';
import { issueToken } from '../auth.js';
import { createSyncEnvelope, loadSodium } from '../browserEnvelope/envelope.js';
import { connectDatabase, migrate, type Database } from '../db.js';

import type { SyncBundle, SyncHead, SyncRecord } from '../browserEnvelope/envelope.js';
import type { VaultConfig } from '../config.js';
import type { AddressInfo } from 'node:net';

interface Half { bundle: SyncBundle; records: SyncRecord[]; head: SyncHead; plaintexts: Record<string, string> }
interface Page { head: SyncHead; records: SyncRecord[] }
interface Reply { status: number; body: any; cookie?: string }
type Vault = (method: string, path: string, body?: unknown) => Promise<Reply>;

const katFile = new URL('../browserEnvelope/vault-sync-v3-kat.json', import.meta.url);
const kat = JSON.parse(readFileSync(katFile, 'utf8')) as { password: string; browser: Half };
const databaseUrl = process.env.SULLA_VAULT_TEST_DATABASE_URL;
const VAULT_HOST = 'vault.kat.test';
const VAULT_ORIGIN = `https://${ VAULT_HOST }`;
const SYNTHETIC = JSON.stringify({ synthetic: true });

async function startServer() {
  process.env.SULLA_VAULT_BROWSER_HOST = VAULT_HOST;
  process.env.SULLA_VAULT_BROWSER_ORIGIN = VAULT_ORIGIN;
  const config: VaultConfig = {
    mode:             'server',
    port:             0,
    databaseUrl:      databaseUrl!,
    jwtSecret:        'browser-sync-test-secret-that-is-at-least-thirty-two-characters',
    extensionOrigins: [],
  };
  const db = await connectDatabase(config);
  await migrate(db);
  const server = http.createServer(createApp(db, config));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { config, db, server, port };
}

/** node:http, because fetch can't set the Host header the vault origin is keyed on. */
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const all: Record<string, string> = { ...headers };
  if (payload) all['content-type'] = 'application/json';
  return new Promise((done, fail) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: all }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
        done({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null, cookie });
      });
    });
    request.on('error', fail);
    request.end(payload);
  });
}

/** Mint a handoff with a Vault bearer (the Console API's role) and trade it for a vault-origin cookie. */
async function browserSession(port: number, config: VaultConfig, userId: string, orgId: string): Promise<Vault> {
  const bearer = { authorization: `Bearer ${ issueToken(config, userId) }`, 'x-sulla-organization-id': orgId };
  const handoff = await call(port, 'POST', '/cloud-vault-sync/browser/handoff', bearer, {});
  assert.equal(handoff.status, 201);
  const origin = { host: VAULT_HOST, origin: VAULT_ORIGIN, 'x-sulla-vault-request': '1' };
  const exchanged = await call(port, 'POST', '/cloud-vault-sync/browser/session', origin, { code: handoff.body.code });
  assert.equal(exchanged.status, 201);
  assert.ok(exchanged.cookie?.startsWith('__Host-sulla_vault='));
  const headers = { ...origin, cookie: exchanged.cookie! };
  return (method, path, body) => call(port, method, `/cloud-vault-sync${ path }`, headers, body);
}

async function insertUser(db: Database, userId: string, keys?: SyncBundle): Promise<void> {
  const kdf = keys ? { salt: keys.kdf.salt, parameters: { memoryBytes: keys.kdf.memoryBytes, operations: keys.kdf.ops } } : SYNTHETIC;
  await db.query(
    `INSERT INTO users(id, email, login_hash_salt, login_hash_verifier, public_key,
                       encrypted_private_key, encrypted_user_key, kdf)
     VALUES ($1, $2, 'x', 'x', $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [userId, `${ userId }@example.test`, keys?.publicKey ?? 'synthetic', keys?.encryptedPrivateKey ?? SYNTHETIC,
      keys?.encryptedUserKey ?? SYNTHETIC, kdf],
  );
}

async function addMember(db: Database, orgId: string, userId: string, role: 'owner' | 'member'): Promise<void> {
  await db.query(
    `INSERT INTO org_members(org_id, user_id, role, wrapped_org_key, status) VALUES ($1, $2, $3, $4, 'confirmed')`,
    [orgId, userId, role, SYNTHETIC],
  );
}

async function createOrg(db: Database, createdBy: string): Promise<string> {
  const created = await db.query<{ id: string }>(
    'INSERT INTO orgs(encrypted_name, created_by) VALUES ($1, $2) RETURNING id',
    [SYNTHETIC, createdBy],
  );
  return created.rows[0].id;
}

test('the browser envelope KAT passes on the server path', { skip: !databaseUrl }, async() => {
  const { config, db, server, port } = await startServer();
  try {
    const half = kat.browser;
    const userId = half.bundle.vaultUserId;
    const vaultId = half.bundle.vaultId;
    // The account row carries exactly the KAT's wrapped keys, as server onboarding would have stored them.
    await insertUser(db, userId, half.bundle);
    const orgId = await createOrg(db, userId);
    await addMember(db, orgId, userId, 'owner');
    // The fixture is bound to its vault id, so this run's org takes that org vault id.
    await db.query('DELETE FROM browser_sync_vaults WHERE vault_id = $1', [vaultId]);
    await db.query('INSERT INTO browser_sync_vaults(vault_id, org_id) VALUES ($1, $2)', [vaultId, orgId]);

    const vault = await browserSession(port, config, userId, orgId);
    const status = (await vault('GET', '/status')).body;
    assert.deepEqual([status.enabled, status.setup, status.vaultId], [false, 'enroll', vaultId]);
    // The server derives the same unsigned bundle fields the browser MAC'd.
    const enrollment = await vault('GET', `/vaults/${ vaultId }/enrollment`);
    const { format: _format, v: _v, mac: _mac, ...signed } = half.bundle;
    assert.deepEqual(enrollment.body.fields, signed);
    const upload = { bundle: half.bundle, scope: 'personal', records: half.records, head: half.head };
    assert.equal((await vault('PUT', `/vaults/${ vaultId }?op=create`, upload)).status, 201);

    const env = createSyncEnvelope(await loadSodium());
    const bundle = (await vault('GET', `/vaults/${ vaultId }/bundle`)).body as SyncBundle;
    const userKey = env.unlockBundle(bundle, kat.password);
    const listed = (await vault('GET', `/vaults/${ vaultId }/records?scope=personal&since=0`)).body as Page;
    const personal = { vaultId, scope: 'personal' };
    env.verifyHead(listed.head, userKey, { ...personal, records: listed.records });
    for (const record of listed.records) {
      env.verifyRecord(record, userKey, personal);
      if (record.deleted) continue;
      const text = await decryptItemText(record.item as never, userKey, { itemId: record.id, ownerId: userId });
      assert.equal(text, half.plaintexts[record.id]);
    }

    // A browser edit: CAS on the head, and a replay of the same commit is refused.
    const edited = listed.records[0];
    const plaintext = JSON.stringify({ ...JSON.parse(half.plaintexts[edited.id]), password: 'rotated-synthetic' });
    const item = env.encryptItem(plaintext, userKey, userId, edited.id);
    const generation = edited.generation + 1;
    const record = env.buildRecord({ ...personal, kind: 'item', id: edited.id, generation, deleted: false, item }, userKey);
    const merged = listed.records.map(r => (r.id === record.id ? record : r));
    const seq = listed.head.seq + 1;
    const head = env.buildHead({ ...personal, seq, records: merged, prevHeadMac: listed.head.mac }, userKey);
    const writes = [{ id: record.id, baseGeneration: edited.generation, record }];
    const body = { scope: 'personal', expectedHeadSeq: listed.head.seq, writes, head };
    assert.equal((await vault('POST', `/vaults/${ vaultId }/commit`, body)).status, 200);
    assert.equal((await vault('POST', `/vaults/${ vaultId }/commit`, body)).body.error, 'head_stale');
    const delta = (await vault('GET', `/vaults/${ vaultId }/records?scope=personal&since=${ listed.head.seq }`)).body as Page;
    env.verifyHead(delta.head, userKey, {
      ...personal,
      records:             merged,
      minSeq:              listed.head.seq,
      expectedPrevHeadMac: listed.head.mac,
    });
    assert.deepEqual(delta.records.map(r => r.id), [record.id]);
    userKey.fill(0);

    // Postgres holds ciphertext only: no plaintext from any item, before or after the edit.
    const rows = await db.query<{ text: string }>(
      `SELECT string_agg(t::text, ' ') AS text FROM (
         SELECT record AS t FROM browser_sync_records WHERE vault_id = $1
         UNION ALL SELECT head FROM browser_sync_heads WHERE vault_id = $1
         UNION ALL SELECT bundle FROM browser_sync_bundles WHERE vault_id = $1) stored`,
      [vaultId],
    );
    const plaintexts = ['p@ss-browser', 'rotated-synthetic', 'fixture@example.test', 'browser bank', 'bank.example.test'];
    for (const value of [...plaintexts, 'synthetic only', kat.password]) {
      assert.ok(!rows.rows[0].text.includes(value), 'a plaintext value reached Postgres');
    }
  } finally {
    server.close();
    await db.end();
  }
});

test('a member without access to a collection never receives its records', { skip: !databaseUrl }, async() => {
  const { config, db, server, port } = await startServer();
  try {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const outsiderId = randomUUID();
    for (const id of [ownerId, memberId, outsiderId]) await insertUser(db, id);
    const orgId = await createOrg(db, ownerId);
    const outsiderOrg = await createOrg(db, ownerId);
    await addMember(db, orgId, ownerId, 'owner');
    await addMember(db, orgId, memberId, 'member');
    await addMember(db, outsiderOrg, outsiderId, 'member');
    const collection = await db.query<{ id: string }>(
      'INSERT INTO collections(org_id, encrypted_name, wrapped_collection_key) VALUES ($1, $2, $2) RETURNING id',
      [orgId, SYNTHETIC],
    );
    const scope = collection.rows[0].id;

    // The owner writes the collection's first record, sealed under a synthetic collection key.
    const env = createSyncEnvelope(await loadSodium());
    const owner = await browserSession(port, config, ownerId, orgId);
    const vaultId = (await owner('GET', '/status')).body.vaultId as string;
    const key = new Uint8Array(randomBytes(32));
    const id = randomUUID();
    const item = env.encryptItem(JSON.stringify({ type: 'apiKey', name: 'synthetic' }), key, scope, id);
    const first = env.buildRecord({ vaultId, scope, kind: 'item', id, generation: 1, deleted: false, item }, key);
    const firstHead = env.buildHead({ vaultId, scope, seq: 1, records: [first] }, key);
    const create = { scope, expectedHeadSeq: 0, writes: [{ id, baseGeneration: 0, record: first }], head: firstHead };
    assert.equal((await owner('POST', `/vaults/${ vaultId }/commit`, create)).status, 200);
    const next = env.buildRecord({ vaultId, scope, kind: 'item', id, generation: 2, deleted: false, item }, key);
    const nextHead = env.buildHead({ vaultId, scope, seq: 2, records: [next], prevHeadMac: firstHead.mac }, key);
    const edit = { scope, expectedHeadSeq: 1, writes: [{ id, baseGeneration: 1, record: next }], head: nextHead };
    key.fill(0);

    const reader = await browserSession(port, config, memberId, orgId);
    const records = `/vaults/${ vaultId }/records?scope=${ scope }`;
    const commit = `/vaults/${ vaultId }/commit`;
    assert.equal((await reader('GET', '/status')).body.collections, 0);
    assert.equal((await reader('GET', records)).status, 404);
    assert.equal((await reader('POST', commit, edit)).status, 404);

    // `view` lets them read but not write; taking it away closes the scope again.
    const grant = [scope, memberId];
    await db.query('INSERT INTO collection_members(collection_id, user_id, can_view) VALUES ($1, $2, true)', grant);
    assert.deepEqual((await reader('GET', records)).body.records.map((r: SyncRecord) => r.id), [id]);
    assert.equal((await reader('POST', commit, edit)).body.error, 'edit_required');
    await db.query('DELETE FROM collection_members WHERE collection_id = $1 AND user_id = $2', grant);
    assert.equal((await reader('GET', records)).status, 404);

    // Someone from another organization can't get a handoff for this one, nor read its vault from their own.
    const foreign = { authorization: `Bearer ${ issueToken(config, outsiderId) }`, 'x-sulla-organization-id': orgId };
    assert.equal((await call(port, 'POST', '/cloud-vault-sync/browser/handoff', foreign, {})).status, 404);
    const outsider = await browserSession(port, config, outsiderId, outsiderOrg);
    assert.equal((await outsider('GET', records)).status, 404);
  } finally {
    server.close();
    await db.end();
  }
});
