// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 (S4a): key material lifecycle in the real LocalVaultAuthority — zeroization on lock and
// after each lent use, lock-during-await (TOCTOU) on every path that wraps the user key, and the
// device-enrollment adopt -> commit success path end to end (PGlite database, real transport
// envelope crypto; only the bundle codec and stored-key reader are doubles).
//
// Fail on main (before this change): lock wipes pending enrollments; an expired or replaced
// staged enrollment is zeroed; both wrap paths refuse after a lock mid-await. The rest are
// coverage that already passes on main.

import { webcrypto } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesTransportEnvelopeService } from '@sulla/vault-crypto';
import { afterEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';
import { E9VaultTestDatabase } from '../../Support/E9Legacy/E9FilesKeysDatabase';

const TOKENS = { bootstrap: 'b'.repeat(40), control: 'c'.repeat(40), approval: 'a'.repeat(40), broker: 'r'.repeat(40), files: 'f'.repeat(40) };
const USER_ID = 'e10a0000-0000-4000-8000-000000000001';
const VAULT_ID = 'e10b0000-0000-4000-8000-000000000002';
const REQUEST_ID = 'e10c0000-0000-4000-8000-000000000003';
const subtle = webcrypto.subtle;

type Staged = { expiresAt: number; bundle: unknown; head: unknown; userKey: Uint8Array; privateKey: Uint8Array; masterKey: Uint8Array; cloudUserId: string };

/** The authority state these specs inspect. Collaborator-only state, reached by name on purpose. */
interface AuthorityState {
  keys: { userId: string; publicKey: string; userKey: Uint8Array; privateKey: Uint8Array; legacyVmk?: Buffer } | null;
  stagedCacheUpdate: { masterKey: Uint8Array; expiresAt: number; generation: number } | null;
  pendingVaultEnrollments: Map<string, Staged>;
  codecProvider: { get(): Promise<{ verifyBundle(bundle: unknown, userKey: Uint8Array): void }> };
}

const zeroed = (bytes: Uint8Array) => bytes.every(byte => byte === 0);

class Deferred {
  release!: () => void;
  readonly promise = new Promise<void>(resolve => { this.release = resolve });
}

/** A P-256 device that receives transport envelopes. */
class Device {
  publicKey = '';
  privateKeyJwk!: webcrypto.JsonWebKey;

  static async create(): Promise<Device> {
    const device = new Device();
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as webcrypto.CryptoKeyPair;
    device.publicKey = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    device.privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
    return device;
  }
}

/** Sync-state lookup whose next read waits until the spec releases it. */
class GatedSyncState {
  readonly gate = new Deferred();
  reached = false;
  async find() {
    this.reached = true;
    await this.gate.promise;
    return { rows: [{ vault_id: VAULT_ID, epoch: 1 }], rowCount: 1 };
  }
}

class AuthorityFixture {
  readonly authority: LocalVaultAuthority;
  readonly state: AuthorityState;

  constructor(db: Database, options: { syncState?: unknown; keyReader?: unknown } = {}) {
    const config = {
      mode: 'desktop', port: 0, databaseUrl: 'postgresql://synthetic/unused', extensionOrigins: [],
      auditSpoolDir: mkdtempSync(join(tmpdir(), 'e10-key-lifecycle-')),
      bootstrapServiceId: 'bootstrap', bootstrapServiceToken: TOKENS.bootstrap,
      controlServiceId: 'control', controlServiceToken: TOKENS.control,
      approvalServiceId: 'approval', approvalServiceToken: TOKENS.approval,
      brokerServiceId: 'broker', brokerServiceToken: TOKENS.broker,
      filesServiceId: 'files', filesServiceToken: TOKENS.files,
    };
    const positional: unknown[] = [db, config];
    positional[10] = options.syncState;
    positional[12] = options.keyReader;
    this.authority = new (LocalVaultAuthority as unknown as new (...args: unknown[]) => LocalVaultAuthority)(...positional);
    this.state = this.authority as unknown as AuthorityState;
  }

  static noDatabase(options: { syncState?: unknown } = {}): AuthorityFixture {
    return new AuthorityFixture({ query: async() => ({ rows: [], rowCount: 0 }), connect: async() => { throw new Error('no database') } } as unknown as Database, options);
  }

  unlock(): void {
    this.state.keys = {
      userId: USER_ID, publicKey: 'user-public-key',
      userKey: new Uint8Array(32).fill(0x11), privateKey: new Uint8Array(32).fill(0x22), legacyVmk: Buffer.alloc(32, 0x33),
    };
  }

  stage(requestId: string, expiresAt: number): Staged {
    const staged: Staged = {
      expiresAt, bundle: {}, head: {}, cloudUserId: 'cloud-user',
      userKey: new Uint8Array(32).fill(1), privateKey: new Uint8Array(32).fill(2), masterKey: new Uint8Array(32).fill(3),
    };
    this.state.pendingVaultEnrollments.set(requestId, staged);
    return staged;
  }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('Lock zeroes every key buffer it owns', () => {
  it('zeroes the unlocked keys and the staged cache-update master key', () => { // risk: key material survives lock
    const fx = AuthorityFixture.noDatabase();
    fx.unlock();
    const keys = fx.state.keys!;
    fx.authority.stageCacheUpdate(new Uint8Array(32).fill(0x44));
    const staged = fx.state.stagedCacheUpdate!;
    fx.authority.lockNow();
    expect([keys.userKey, keys.privateKey, keys.legacyVmk!, staged.masterKey].every(zeroed)).toBe(true);
    expect(fx.authority.status()).toMatchObject({ unlocked: false, state: 'locked', cacheUpdateRequired: false });
  });

  it('zeroes and forgets every pending device enrollment', () => { // risk: enrollment master/user keys outlive a lock (fails on main)
    const fx = AuthorityFixture.noDatabase();
    const staged = [fx.stage(REQUEST_ID, Date.now() + 60_000), fx.stage('other-request', Date.now() + 60_000)];
    fx.authority.lockNow();
    for (const entry of staged) expect([entry.userKey, entry.privateKey, entry.masterKey].every(zeroed)).toBe(true);
    expect(fx.state.pendingVaultEnrollments.size).toBe(0);
  });
});

describe('Lent key copies are erased and never outlive a lock', () => {
  it('erases the lent identity and user-key copies after success and after failure, leaving the vault keys intact', async() => { // risk: lent key copies left in memory
    const fx = AuthorityFixture.noDatabase();
    fx.unlock();
    const lent: Uint8Array[] = [];
    await fx.authority.withUnlockedIdentity(async identity => { lent.push(identity.privateKey) });
    await expect(fx.authority.withUnlockedUserKey(async keys => { lent.push(keys.userKey); throw new Error('boom') })).rejects.toThrow('boom');
    expect(lent).toHaveLength(2);
    expect(lent.every(zeroed)).toBe(true);
    expect(fx.state.keys!.privateKey.every(byte => byte === 0x22)).toBe(true);
    expect(fx.state.keys!.userKey.every(byte => byte === 0x11)).toBe(true);
  });

  it('fails an operation whose Vault locks while it is awaiting, and erases its copy', async() => { // risk: result computed from key material escapes after lock (TOCTOU)
    const fx = AuthorityFixture.noDatabase();
    fx.unlock();
    const gate = new Deferred();
    let lent: Uint8Array | undefined;
    const pending = fx.authority.withUnlockedIdentity(async identity => { lent = identity.privateKey; await gate.promise; return 'derived-from-key' });
    await tick();
    fx.authority.lockNow();
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
    expect(zeroed(lent!)).toBe(true);
  });
});

describe('Wrapping the user key refuses after a lock mid-await', () => {
  it('approved-device wrap: a lock during the sync-state lookup fails the request', async() => { // risk: wrapped user key returned after lock (fails on main)
    const syncState = new GatedSyncState();
    const fx = AuthorityFixture.noDatabase({ syncState });
    fx.unlock();
    const device = await Device.create();
    const pending = fx.authority.wrapUserKeyForApprovedDevice('approval', TOKENS.approval, {
      requestId: REQUEST_ID, vaultId: VAULT_ID, vaultEpoch: 1, publicKey: device.publicKey, approved: true,
    });
    await tick();
    expect(syncState.reached).toBe(true);
    fx.authority.lockNow();
    syncState.gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
  });

  it('approved-device wrap still succeeds while unlocked and leaves the vault user key intact', async() => { // risk: copy-and-erase destroys the live key
    const syncState = new GatedSyncState();
    syncState.gate.release();
    const fx = AuthorityFixture.noDatabase({ syncState });
    fx.unlock();
    const device = await Device.create();
    const result = await fx.authority.wrapUserKeyForApprovedDevice('approval', TOKENS.approval, {
      requestId: REQUEST_ID, vaultId: VAULT_ID, vaultEpoch: 1, publicKey: device.publicKey, approved: true,
    });
    expect(result.wrappedUserKey).toMatchObject({ epk: expect.any(String), ct: expect.any(String) });
    expect(fx.state.keys!.userKey.every(byte => byte === 0x11)).toBe(true);
  });

  it('enrollment wrap: a lock while the bundle codec loads fails the request', async() => { // risk: zeroed or stale user key shipped to a new device (fails on main)
    const fx = AuthorityFixture.noDatabase();
    fx.unlock();
    const gate = new Deferred();
    let codecRequested = false;
    fx.state.codecProvider = { get: async() => { codecRequested = true; await gate.promise; return { verifyBundle: () => undefined } } };
    const device = await Device.create();
    const pending = fx.authority.wrapVaultEnrollment('approval', TOKENS.approval, {
      approved: true, bundle: {}, head: { vaultId: VAULT_ID, scope: 'personal' },
      vaultId: VAULT_ID, vaultEpoch: 1, requestId: REQUEST_ID, publicKey: device.publicKey,
    } as never);
    await tick();
    expect(codecRequested).toBe(true);
    fx.authority.lockNow();
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
  });
});

/** Adopt/commit harness: a fresh vault database, a real transport envelope from a "Cloud" sender. */
class EnrollmentFixture {
  readonly database = new E9VaultTestDatabase();
  readonly transport = new FilesTransportEnvelopeService();
  readonly userKey = new Uint8Array(32).fill(0x61);
  readonly privateKey = new Uint8Array(32).fill(0x62);
  readonly masterKey = new Uint8Array(32).fill(0x63);
  readonly verified: Uint8Array[] = [];
  readonly bundle = {
    format: 'sulla-vault-sync-bundle', v: 2, mac: 'bundle-mac', vaultId: VAULT_ID, vaultUserId: USER_ID, epoch: 1, bundleGeneration: 4,
    kdf: { alg: 'argon2id13', salt: 'kdf-salt', memoryBytes: 67_108_864, ops: 3 },
    encryptedUserKey: { ct: 'wrapped-user-key' }, publicKey: 'vault-public-key', encryptedPrivateKey: { ct: 'wrapped-private-key' },
  };
  readonly head = { format: 'sulla-vault-sync-head', v: 1, vaultId: VAULT_ID, scope: 'personal', seq: 1, stateHash: 's', prevHeadMac: '', mac: 'head-mac' };
  device!: Device;
  fx!: AuthorityFixture;

  async setup(): Promise<this> {
    await this.database.setup();
    this.device = await Device.create();
    const keyReader = { get: async() => ({ unwrapUserKey: () => Uint8Array.from(this.userKey), unwrapUserPrivateKey: () => Uint8Array.from(this.privateKey) }) };
    this.fx = new AuthorityFixture(this.database.db, { keyReader });
    this.fx.state.codecProvider = { get: async() => ({ verifyBundle: (_bundle: unknown, key: Uint8Array) => { this.verified.push(Uint8Array.from(key)) } }) };
    return this;
  }

  async adopt(requestId = REQUEST_ID): Promise<{ bundleMac: string; headMac: string }> {
    const payload = new TextEncoder().encode(JSON.stringify({ userKey: Buffer.from(this.userKey).toString('base64url'), bundle: this.bundle, head: this.head }));
    const wrappedUserKey = await this.transport.wrap(payload, this.device.publicKey, requestId, VAULT_ID, 1);
    return this.fx.authority.adoptVaultEnrollment('approval', TOKENS.approval, {
      requestId, vaultId: VAULT_ID, vaultEpoch: 1, privateKeyJwk: this.device.privateKeyJwk, wrappedUserKey,
      masterKey: Buffer.from(this.masterKey).toString('base64url'), cloudUserId: 'cloud-user-e10',
    });
  }
}

describe('Device enrollment adopt -> commit through LocalVaultAuthority', () => {
  let enrollment: EnrollmentFixture | undefined;
  afterEach(async() => { await enrollment?.database.close(); enrollment = undefined });

  it('creates the vault owner, records sync state, unlocks with the enrolled keys and erases the staged copies', async() => { // risk: enrollment loses or corrupts the vault identity
    enrollment = await new EnrollmentFixture().setup();
    const { fx, database } = enrollment;
    await expect(enrollment.adopt()).resolves.toEqual({ bundleMac: 'bundle-mac', headMac: 'head-mac' });
    expect(enrollment.verified.map(key => Buffer.from(key).toString('hex'))).toEqual(['61'.repeat(32)]);
    const staged = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    expect(staged.cloudUserId).toBe('cloud-user-e10');

    await expect(fx.authority.commitVaultEnrollment('approval', TOKENS.approval, REQUEST_ID)).resolves.toEqual({ adopted: true });

    expect(fx.authority.status()).toEqual({ state: 'unlocked', unlocked: true, principalId: USER_ID, cacheUpdateRequired: true });
    const users = await database.db.query<{ id: string; public_key: string; kdf: { cloudUserId: string; password: unknown } }>('SELECT id,public_key,kdf FROM users');
    expect(users.rows).toEqual([{ id: USER_ID, public_key: 'vault-public-key', kdf: expect.objectContaining({
      authority: 'container', cloudUserId: 'cloud-user-e10', password: { salt: 'kdf-salt', parameters: { memoryBytes: 67_108_864, operations: 3 } },
    }) }]);
    const sync = await database.db.query<{ vault_id: string; epoch: string; bundle_generation: string }>(
      'SELECT owner_user_id,vault_id,epoch::text AS epoch,bundle_generation::text AS bundle_generation FROM cloud_vault_sync_state');
    expect(sync.rows).toEqual([{ owner_user_id: USER_ID, vault_id: VAULT_ID, epoch: '1', bundle_generation: '4' }]);
    const lent = await fx.authority.withUnlockedUserKey(async keys => Buffer.from(keys.userKey).toString('hex'));
    expect(lent).toBe('61'.repeat(32));
    expect([staged.userKey, staged.privateKey, staged.masterKey].every(zeroed)).toBe(true);
    expect(fx.state.pendingVaultEnrollments.size).toBe(0);
    await expect(fx.authority.commitVaultEnrollment('approval', TOKENS.approval, REQUEST_ID)).rejects.toMatchObject({ code: 'invalid_operation', status: 409 });
  });

  it('zeroes a staged enrollment that a repeat adopt replaces', async() => { // risk: orphaned master key in memory (fails on main)
    enrollment = await new EnrollmentFixture().setup();
    await enrollment.adopt();
    const first = enrollment.fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    await enrollment.adopt();
    const second = enrollment.fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    expect(second).not.toBe(first);
    expect([first.userKey, first.privateKey, first.masterKey].every(zeroed)).toBe(true);
    expect(second.masterKey.every(byte => byte === 0x63)).toBe(true);
  });

  it('zeroes an expired staged enrollment on commit and on the next adopt', async() => { // risk: expired enrollment keys kept forever (fails on main)
    enrollment = await new EnrollmentFixture().setup();
    const { fx } = enrollment;
    const expiredOnCommit = fx.stage(REQUEST_ID, Date.now() - 1);
    await expect(fx.authority.commitVaultEnrollment('approval', TOKENS.approval, REQUEST_ID)).rejects.toMatchObject({ code: 'invalid_operation', status: 409 });
    expect([expiredOnCommit.userKey, expiredOnCommit.privateKey, expiredOnCommit.masterKey].every(zeroed)).toBe(true);

    const abandoned = fx.stage('abandoned-request', Date.now() - 1);
    await enrollment.adopt();
    expect([abandoned.userKey, abandoned.privateKey, abandoned.masterKey].every(zeroed)).toBe(true);
    expect([...fx.state.pendingVaultEnrollments.keys()]).toEqual([REQUEST_ID]);
    const users = await enrollment.database.db.query('SELECT 1 FROM users');
    expect(users.rows).toEqual([]);
  });
});
