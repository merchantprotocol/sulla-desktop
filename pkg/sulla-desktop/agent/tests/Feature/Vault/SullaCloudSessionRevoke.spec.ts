// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { IdentityError, InProcessRefreshLock, TokenPair } from '@sulla/domain';
import { encryptItem } from '@sulla/vault-crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, Queryable } from '../../../../../../services/sulla-vault/src/db';
import { PostgresSullaCloudRevocationRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresSullaCloudRevocationRepository';
import { PostgresIntegrationStateRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresVaultAuthorityRepositories';
import { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresVaultItemRepositories';
import { SULLA_CLOUD_LOGOUT_URL, SULLA_CLOUD_REFRESH_URL } from '../../../../../../services/sulla-vault/src/sullaCloudRelay';
import { PostgresSullaCloudItemGateway } from '../../../../../../services/sulla-vault/src/sullaCloudSession/PostgresSullaCloudItemGateway';
import { SullaCloudSessionManagerFactory } from '../../../../../../services/sulla-vault/src/sullaCloudSession/SullaCloudSessionManagerFactory';
import { SullaCloudHttpError, VaultCloudAccountTransport, type SullaCloudHttpPort } from '../../../../../../services/sulla-vault/src/sullaCloudSession/VaultCloudAccountTransport';
import { VaultItemTokenStore } from '../../../../../../services/sulla-vault/src/sullaCloudSession/VaultItemTokenStore';
import { VaultRevocationQueue } from '../../../../../../services/sulla-vault/src/sullaCloudSession/VaultRevocationQueue';

// Real Postgres schema (PGlite + the shipped migrations), real vault encryption, real domain services.
// Only the Sulla Cloud network is faked, behind the SullaCloudHttpPort.
class EmbeddedDatabase {
  private readonly pglite = new PGlite();
  async setup(): Promise<void> {
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort()) {
      await this.pglite.exec((await readFile(resolve(dir, file), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
  }
  async query<T>(sql: string, values?: unknown[]) {
    const r = await this.pglite.query<T>(sql, values) as { rows: T[]; affectedRows?: number };
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
  async connect() { return this; }
  release() {}
  close() { return this.pglite.close(); }
}

const jwt = (secondsLeft: number, tag: string) => {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${ part({ alg: 'HS256' }) }.${ part({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + secondsLeft, tag }) }.sig`;
};

class FakeCloud implements SullaCloudHttpPort {
  calls: Array<{ url: string; body: { refreshToken: string } }> = [];
  logoutBehaviour: 'ok' | 'offline' | number = 'ok';
  refreshBehaviour: 'ok' | 'no-new-refresh-token' | number = 'ok';
  refreshGate: Promise<void> | null = null;
  private rotations = 0;
  async postJson(url: string, body: { refreshToken: string }) {
    this.calls.push({ url, body });
    if (url === SULLA_CLOUD_LOGOUT_URL) {
      if (this.logoutBehaviour === 'offline') throw Object.assign(new Error(`ECONNREFUSED carrying ${ body.refreshToken }`), { status: 403 });
      return { status: this.logoutBehaviour === 'ok' ? 200 : this.logoutBehaviour, body: {} };
    }
    if (this.refreshGate) await this.refreshGate;
    if (typeof this.refreshBehaviour === 'number') return { status: this.refreshBehaviour, body: {} };
    this.rotations += 1;
    return { status: 200, body: { accessToken: jwt(900, `a${ this.rotations }`), ...(this.refreshBehaviour === 'ok' ? { refreshToken: `rt-${ this.rotations + 1 }` } : {}) } };
  }
  count(url: string) { return this.calls.filter(c => c.url === url).length; }
}

const database = new EmbeddedDatabase();
const userKey = randomBytes(32);
const userId = randomUUID();
let cloud: FakeCloud;
let items: PostgresVaultItemRepository;
let state: PostgresIntegrationStateRepository;
let revocations: PostgresSullaCloudRevocationRepository;
let audit: PostgresVaultAuditLogRepository;

class SessionRig {
  readonly vault = {
    userKey: () => ({ userId, userKey }),
    generation: () => 1,
    requireGeneration: () => undefined,
    transaction: <T>(work: (client: Queryable) => Promise<T>) => work(database as unknown as Queryable),
    auditHumanAction: async(client: Queryable, actor: string, action: string, itemId?: string | null) => { await audit.recordHumanAction([actor, itemId ?? null, action], client); },
  };
  readonly lock = new InProcessRefreshLock();
  readonly gateway = new PostgresSullaCloudItemGateway(this.vault, items, state);
  readonly store = new VaultItemTokenStore(this.gateway);
  readonly queue = new VaultRevocationQueue(revocations, this.vault);
  readonly manager = new SullaCloudSessionManagerFactory(this.vault, {
    items, state, revocations, serialize: (name, work) => this.lock.run(name, work), postJson: (url, body) => cloud.postJson(url, body),
  }).create();
}

async function seedSession(accessSecondsLeft: number, refreshToken = 'rt-1'): Promise<string> {
  const id = randomUUID();
  const policy = { mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false };
  const plaintext = { type: 'apiKey', name: 'Sulla Cloud', agentPolicy: policy, integration: { integrationId: 'sulla-cloud', accountId: userId, properties: {
    access_token: jwt(accessSecondsLeft, 'a0'), refresh_token: refreshToken, user_id: 'user-1', active_contractor_id: 'user-1', contractors_json: '[]', connection_status: 'connected' } } };
  const encrypted = await encryptItem(JSON.stringify(plaintext), userKey, { itemId: id, ownerId: userId });
  await items.insertSullaCloudAccount([id, userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy, `sulla-cloud/${ userId }`]);
  await state.upsertCloud(userId, 'sulla-cloud', userId);
  return id;
}

const itemRows = () => database.query<{ id: string; ciphertext: unknown; deleted_at: string | null }>('SELECT id,ciphertext,deleted_at FROM items WHERE owner_user_id=$1', [userId]);
const queuedRows = () => database.query<{ ciphertext: unknown }>('SELECT ciphertext FROM sulla_cloud_pending_revocations');

beforeAll(async() => {
  await database.setup();
  items = new PostgresVaultItemRepository(database as unknown as Database);
  state = new PostgresIntegrationStateRepository(database as unknown as Database);
  revocations = new PostgresSullaCloudRevocationRepository(database as unknown as Database);
  audit = new PostgresVaultAuditLogRepository(database as unknown as Database);
  await database.query(`INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf) VALUES ($1,$2,$3,$4,'pk','{}'::jsonb,'{"ciphertext":"key"}'::jsonb,'{"alg":"test"}'::jsonb)`, [userId, 'u@example.test', Buffer.from('salt'), Buffer.from('verifier')]);
});
afterAll(() => database.close());
beforeEach(async() => {
  cloud = new FakeCloud();
  await database.query('DELETE FROM sulla_cloud_pending_revocations');
  await database.query('DELETE FROM local_integration_state');
  await database.query('UPDATE items SET integration_ref=NULL');
});
afterEach(() => vi.restoreAllMocks());

describe.sequential('vault sign-out revokes the Sulla Cloud session', () => {
  it('POSTs /auth/logout with the vault-held refresh token in the body, then destroys the stored ciphertext', async() => { // risk: S2 session stays valid server-side after sign-out
    const id = await seedSession(900);
    const rig = new SessionRig();
    const result = await rig.manager.signOut();
    expect(result).toEqual({ remoteRevoked: true, queued: false, failedSteps: [] });
    expect(cloud.calls).toEqual([{ url: SULLA_CLOUD_LOGOUT_URL, body: { refreshToken: 'rt-1' } }]);
    expect(await rig.store.read()).toBeNull();
    const row = (await itemRows()).rows.find(r => r.id === id)!;
    expect(row.ciphertext).toEqual({});
    expect(row.deleted_at).not.toBeNull();
    expect((await database.query('SELECT 1 FROM local_integration_state WHERE owner_user_id=$1', [userId])).rows).toHaveLength(0);
  });

  it('signing out offline still clears locally and queues the revoke durably; the next drain revokes it', async() => { // risk: device stays signed in offline / revoke lost
    await seedSession(900);
    const rig = new SessionRig();
    cloud.logoutBehaviour = 'offline';
    const result = await rig.manager.signOut();
    expect(result).toMatchObject({ remoteRevoked: false, queued: true });
    expect(await rig.store.read()).toBeNull();
    const queued = (await queuedRows()).rows;
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued[0].ciphertext)).not.toContain('rt-1');
    expect(await rig.queue.drain()).toEqual(['rt-1']);

    cloud.logoutBehaviour = 'ok';
    cloud.calls = [];
    await new SessionRig().manager.retryPendingRevocations(); // a fresh manager = an app restart
    expect(cloud.calls).toEqual([{ url: SULLA_CLOUD_LOGOUT_URL, body: { refreshToken: 'rt-1' } }]);
    expect((await queuedRows()).rows).toHaveLength(0);
  });

  it('keeps a revoke queued on a 5xx, and drops it when the server already rejects the token', async() => { // risk: revoke lost on a server blip / queue never empties
    await seedSession(900);
    cloud.logoutBehaviour = 503;
    expect(await new SessionRig().manager.signOut()).toMatchObject({ remoteRevoked: false, queued: true });
    const rig = new SessionRig();
    await rig.manager.retryPendingRevocations();
    expect(await rig.queue.drain()).toEqual(['rt-1']);
    cloud.logoutBehaviour = 401;
    await rig.manager.retryPendingRevocations();
    expect(await rig.queue.drain()).toEqual([]);
  });

  it('never prints a token to the logs, and its errors carry no token', async() => { // risk: secret disclosure
    await seedSession(900);
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
    cloud.logoutBehaviour = 'offline';
    const rig = new SessionRig();
    const accessToken = (await rig.store.read())!.tokens.accessToken;
    await rig.manager.signOut();
    await rig.manager.retryPendingRevocations();
    const transport = new VaultCloudAccountTransport(cloud);
    const failure = await transport.logout({ refreshToken: 'rt-secret' }).catch((e: Error) => e);
    expect(String((failure as Error).message)).not.toContain('rt-secret');
    const printed = logs.flatMap(spy => spy.mock.calls).map(args => args.map(String).join(' ')).join('\n');
    expect(printed).not.toContain('rt-1');
    expect(printed).not.toContain(accessToken);
  });

  it('scrubs earlier soft-deleted rows that still held old refresh tokens, and is idempotent', async() => { // risk: stale ciphertext of old sessions survives sign-out
    const oldId = await seedSession(900, 'rt-old');
    await database.query(`UPDATE items SET deleted_at=now(),integration_ref='sulla-cloud/old' WHERE id=$1`, [oldId]);
    await seedSession(900, 'rt-1');
    const rig = new SessionRig();
    const newId = (await itemRows()).rows.find(r => r.id !== oldId && JSON.stringify(r.ciphertext) !== '{}')!.id;
    expect(await rig.gateway.purge()).toBe(true);
    expect((await itemRows()).rows.filter(r => [oldId, newId].includes(r.id) && JSON.stringify(r.ciphertext) !== '{}')).toHaveLength(0);
    expect(await rig.gateway.purge()).toBe(false);
  });

  it('refuses to POST a logout without a token', async() => { // risk: S1 blank-token logout is a silent no-op on the server
    await expect(new VaultCloudAccountTransport(cloud).logout({ refreshToken: '' })).rejects.toThrow();
    expect(cloud.calls).toHaveLength(0);
  });
});

describe.sequential('vault refresh over the shared session classes', () => {
  it('is single-flight: concurrent callers cause one /auth/refresh and share the rotated token', async() => { // risk: refresh-token reuse kills the family
    await seedSession(5);
    const rig = new SessionRig();
    let release!: () => void;
    cloud.refreshGate = new Promise<void>(r => { release = r; });
    const callers = Promise.all([rig.manager.accessToken(), rig.manager.accessToken(), rig.manager.accessToken()]);
    await new Promise(r => setTimeout(r, 25));
    release();
    const tokens = await callers;
    expect(cloud.count(SULLA_CLOUD_REFRESH_URL)).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    const stored = await rig.store.read();
    expect(stored?.tokens.refreshToken).toBe('rt-2');
    expect(stored?.tokens.accessToken).toBe(tokens[0]);
    expect(stored?.revision).toBe(2);
  });

  it('does not refresh a token that still has time, and keeps the old refresh token when the response has none', async() => { // risk: wire compat with /auth/refresh
    await seedSession(900);
    const rig = new SessionRig();
    await rig.manager.accessToken();
    expect(cloud.calls).toHaveLength(0);
    await database.query(`UPDATE items SET integration_ref=NULL,deleted_at=now()`); await database.query('DELETE FROM local_integration_state');
    await seedSession(5);
    cloud.refreshBehaviour = 'no-new-refresh-token';
    await new SessionRig().manager.accessToken();
    expect((await rig.store.read())?.tokens.refreshToken).toBe('rt-1');
    expect(cloud.calls[0]).toEqual({ url: SULLA_CLOUD_REFRESH_URL, body: { refreshToken: 'rt-1' } });
  });

  it('a refresh that finishes after sign-out starts can never write the session back', async() => { // risk: S8 sign-out resurrected by an in-flight refresh
    await seedSession(5);
    const rig = new SessionRig();
    let release!: () => void;
    cloud.refreshGate = new Promise<void>(r => { release = r; });
    const refreshing = rig.manager.accessToken();
    await new Promise(r => setTimeout(r, 25));
    const signingOut = rig.manager.signOut();
    await new Promise(r => setTimeout(r, 25));
    release();
    await refreshing;
    const result = await signingOut;
    expect(await rig.store.read()).toBeNull();
    expect(result.remoteRevoked).toBe(true);
    // The refresh finished first, so the revoke carries the NEWEST token (rt-2), not the one the refresh started with.
    expect(cloud.calls.filter(c => c.url === SULLA_CLOUD_LOGOUT_URL)).toEqual([{ url: SULLA_CLOUD_LOGOUT_URL, body: { refreshToken: 'rt-2' } }]);
    expect(await rig.manager.accessToken()).toBeNull();
  });

  it('a rejected refresh (401) ends the session; a transient failure (503) keeps the tokens', async() => { // risk: S7 network blip signs the user out
    await seedSession(-30);
    const rig = new SessionRig();
    cloud.refreshBehaviour = 503;
    await expect(rig.manager.accessToken()).rejects.toBeInstanceOf(IdentityError);
    expect((await rig.store.read())?.tokens.refreshToken).toBe('rt-1');
    cloud.refreshBehaviour = 401;
    expect(await rig.manager.accessToken()).toBeNull();
    expect(await rig.store.read()).toBeNull();
  });

  it('compare-and-set refuses a stale writer', async() => { // risk: lost update
    await seedSession(900);
    const rig = new SessionRig();
    const seen = (await rig.store.read())!;
    expect(await rig.store.compareAndSet(seen, seen.withTokens(new TokenPair(jwt(900, 'x'), 'rt-x')))).toBe(true);
    expect(await rig.store.compareAndSet(seen, seen.withTokens(new TokenPair(jwt(900, 'y'), 'rt-y')))).toBe(false);
    expect((await rig.store.read())?.tokens.refreshToken).toBe('rt-x');
  });

  it('maps the pinned client failures to transient and HTTP statuses to their own', async() => { // risk: a destination-policy 403 must not look like a server rejection
    const offline = new FakeCloud(); offline.logoutBehaviour = 'offline';
    await expect(new VaultCloudAccountTransport(offline).logout({ refreshToken: 'rt-1' })).rejects.not.toHaveProperty('status');
    const rejected = new FakeCloud(); rejected.logoutBehaviour = 401;
    await expect(new VaultCloudAccountTransport(rejected).logout({ refreshToken: 'rt-1' })).rejects.toBeInstanceOf(SullaCloudHttpError);
  });
});
