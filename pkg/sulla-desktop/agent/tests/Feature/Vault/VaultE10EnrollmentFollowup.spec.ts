// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 (S4a follow-up): staged device-enrollment keys never outlive a lock or their 60 s TTL, and a
// Files key-bundle transaction whose ROLLBACK fails keeps the real error and never returns the
// broken connection to the pool. Real LocalVaultAuthority + real transport envelope crypto; the
// database is a synthetic "no vault yet" double, the bundle codec and stored-key reader are doubles.
//
// Fail on main (before this change): lock mid-adopt, TTL purge, repeat-adopt TTL restart, commit
// purge, failed repeat adopt, and the ROLLBACK-failure test. The "no lock" and "clean rollback"
// tests are guards that pass on main and keep the fix from over-reaching.

import { webcrypto } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesTransportEnvelopeService } from '@sulla/vault-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';
import { PostgresFilesKeyBundleRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresFilesKeyBundleRepository';

const TOKENS = { bootstrap: 'b'.repeat(40), control: 'c'.repeat(40), approval: 'a'.repeat(40), broker: 'r'.repeat(40), files: 'f'.repeat(40) };
const USER_ID = 'e10a0000-0000-4000-8000-000000000011';
const VAULT_ID = 'e10b0000-0000-4000-8000-000000000012';
const REQUEST_ID = 'e10c0000-0000-4000-8000-000000000013';
const TTL_MS = 60_000;
const subtle = webcrypto.subtle;

type Staged = { expiresAt: number; userKey: Uint8Array; privateKey: Uint8Array; masterKey: Uint8Array; bundle: unknown; head: unknown; cloudUserId: string };

/** Collaborator-only authority state, reached by name on purpose. */
interface AuthorityState {
  pendingVaultEnrollments: Map<string, Staged>;
  codecProvider: { get(): Promise<{ verifyBundle(bundle: unknown, userKey: Uint8Array): void }> };
}

const zeroed = (bytes: Uint8Array) => bytes.every(byte => byte === 0);
const erased = (staged: Staged) => [staged.userKey, staged.privateKey, staged.masterKey].every(zeroed);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

class Deferred {
  release!: () => void;
  readonly promise = new Promise<void>(resolve => { this.release = resolve });
}

/** Stored-key reader double; the gate, when armed, holds the private-key unwrap until released. */
class KeyReader {
  readonly privateKeysHandedOut: Uint8Array[] = [];
  gate: Deferred | undefined;
  privateKeyRequested = false;
  private calls = 0;

  constructor(private readonly userKey: Uint8Array, private readonly privateKey: Uint8Array) {}

  async get() {
    this.calls += 1;
    if (this.calls % 2 === 0 && this.gate) {
      this.privateKeyRequested = true;
      await this.gate.promise;
    }
    return {
      unwrapUserKey: () => Uint8Array.from(this.userKey),
      unwrapUserPrivateKey: () => {
        const copy = Uint8Array.from(this.privateKey);
        this.privateKeysHandedOut.push(copy);
        return copy;
      },
    };
  }
}

/** A fresh Desktop with no vault yet, adopting a vault that "Cloud" wrapped for this device. */
class AdoptFixture {
  readonly transport = new FilesTransportEnvelopeService();
  readonly userKey = new Uint8Array(32).fill(0x71);
  readonly reader = new KeyReader(this.userKey, new Uint8Array(32).fill(0x72));
  readonly bundle = { mac: 'bundle-mac', vaultId: VAULT_ID, vaultUserId: USER_ID, encryptedUserKey: { ct: 'u' }, encryptedPrivateKey: { ct: 'p' } };
  readonly head = { vaultId: VAULT_ID, scope: 'personal', mac: 'head-mac' };
  readonly authority: LocalVaultAuthority;
  readonly state: AuthorityState;
  private publicKey = '';
  private privateKeyJwk!: webcrypto.JsonWebKey;

  constructor() {
    const config = {
      mode: 'desktop', port: 0, databaseUrl: 'postgresql://synthetic/unused', extensionOrigins: [],
      auditSpoolDir: mkdtempSync(join(tmpdir(), 'e10-enroll-followup-')),
      bootstrapServiceId: 'bootstrap', bootstrapServiceToken: TOKENS.bootstrap,
      controlServiceId: 'control', controlServiceToken: TOKENS.control,
      approvalServiceId: 'approval', approvalServiceToken: TOKENS.approval,
      brokerServiceId: 'broker', brokerServiceToken: TOKENS.broker,
      filesServiceId: 'files', filesServiceToken: TOKENS.files,
    };
    const noVaultYet = { query: async() => ({ rows: [], rowCount: 0 }), connect: async() => { throw new Error('no database') } } as unknown as Database;
    const positional: unknown[] = [noVaultYet, config];
    positional[12] = { get: () => this.reader.get() };
    this.authority = new (LocalVaultAuthority as unknown as new (...args: unknown[]) => LocalVaultAuthority)(...positional);
    this.state = this.authority as unknown as AuthorityState;
    this.state.codecProvider = { get: async() => ({ verifyBundle: () => undefined }) };
  }

  async setup(): Promise<this> {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as webcrypto.CryptoKeyPair;
    this.publicKey = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    this.privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
    return this;
  }

  /** `wrappedFor` lets a spec send an envelope bound to another request, which must fail verification. */
  async adopt(requestId = REQUEST_ID, wrappedFor = requestId): Promise<{ bundleMac: string; headMac: string }> {
    const payload = new TextEncoder().encode(JSON.stringify({ userKey: Buffer.from(this.userKey).toString('base64url'), bundle: this.bundle, head: this.head }));
    const wrappedUserKey = await this.transport.wrap(payload, this.publicKey, wrappedFor, VAULT_ID, 1);
    return this.authority.adoptVaultEnrollment('approval', TOKENS.approval, {
      requestId, vaultId: VAULT_ID, vaultEpoch: 1, privateKeyJwk: this.privateKeyJwk, wrappedUserKey,
      masterKey: Buffer.alloc(32, 0x73).toString('base64url'), cloudUserId: 'cloud-user-e10',
    } as never);
  }

  stage(requestId: string, expiresAt: number): Staged {
    const staged: Staged = {
      expiresAt, bundle: {}, head: {}, cloudUserId: 'cloud-user',
      userKey: new Uint8Array(32).fill(1), privateKey: new Uint8Array(32).fill(2), masterKey: new Uint8Array(32).fill(3),
    };
    this.state.pendingVaultEnrollments.set(requestId, staged);
    return staged;
  }

  commit(requestId = REQUEST_ID): Promise<{ adopted: true }> {
    return this.authority.commitVaultEnrollment('approval', TOKENS.approval, requestId);
  }
}

afterEach(() => { vi.useRealTimers() });

describe('Adopting a device enrollment never stages keys after a lock', () => {
  it('a lock while adopt awaits the key reader fails with 423, stages nothing and zeroes the unwrapped key', async() => { // risk: staged enrollment keys survive a lock (TOCTOU)
    const fx = await new AdoptFixture().setup();
    fx.reader.gate = new Deferred();
    const pending = fx.adopt();
    for (let i = 0; i < 50 && !fx.reader.privateKeyRequested; i += 1) await tick();
    expect(fx.reader.privateKeyRequested).toBe(true);

    fx.authority.lockNow();
    fx.reader.gate.release();

    await expect(pending).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
    expect(fx.state.pendingVaultEnrollments.size).toBe(0);
    expect(fx.reader.privateKeysHandedOut).toHaveLength(1);
    expect(zeroed(fx.reader.privateKeysHandedOut[0])).toBe(true);
    await expect(fx.commit()).rejects.toMatchObject({ code: 'invalid_operation', status: 409 });
  });

  it('still stages the enrollment when no lock happens', async() => { // risk: the lock guard rejects every enrollment
    const fx = await new AdoptFixture().setup();
    await expect(fx.adopt()).resolves.toEqual({ bundleMac: 'bundle-mac', headMac: 'head-mac' });
    const staged = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    expect(staged.privateKey.every(byte => byte === 0x72)).toBe(true);
    expect(staged.masterKey.every(byte => byte === 0x73)).toBe(true);
  });
});

describe('Staged enrollment keys are purged at their TTL', () => {
  it('zeroes and forgets a staged enrollment when its 60 s TTL passes, with no further request', async() => { // risk: enrollment keys kept in memory past the TTL
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fx = await new AdoptFixture().setup();
    await fx.adopt();
    const staged = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;

    vi.advanceTimersByTime(TTL_MS - 1);
    expect(erased(staged)).toBe(false);
    expect(fx.state.pendingVaultEnrollments.has(REQUEST_ID)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(erased(staged)).toBe(true);
    expect(fx.state.pendingVaultEnrollments.size).toBe(0);
  });

  it('a repeat adopt restarts the TTL: the replaced copy\'s timer never wipes the new one', async() => { // risk: fresh enrollment erased early, commit fails
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fx = await new AdoptFixture().setup();
    await fx.adopt();
    const first = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    vi.advanceTimersByTime(TTL_MS / 2);
    await fx.adopt();
    const second = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    expect(erased(first)).toBe(true);

    vi.advanceTimersByTime(TTL_MS / 2 + 1);
    expect(fx.state.pendingVaultEnrollments.get(REQUEST_ID)).toBe(second);
    expect(erased(second)).toBe(false);
  });

  it('commit purges every other expired enrollment, even for an unknown request', async() => { // risk: abandoned enrollment keys kept in memory
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fx = await new AdoptFixture().setup();
    const abandoned = fx.stage('abandoned-request', Date.now() - 1);
    const live = fx.stage('live-request', Date.now() + TTL_MS);

    await expect(fx.commit('unknown-request')).rejects.toMatchObject({ code: 'invalid_operation', status: 409 });

    expect(erased(abandoned)).toBe(true);
    expect(erased(live)).toBe(false);
    expect([...fx.state.pendingVaultEnrollments.keys()]).toEqual(['live-request']);
  });

  it('a failed repeat adopt leaves no staged copy for that request', async() => { // risk: stale enrollment keys survive a failed retry
    const fx = await new AdoptFixture().setup();
    await fx.adopt();
    const first = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;

    await expect(fx.adopt(REQUEST_ID, 'some-other-request')).rejects.toMatchObject({ code: 'invalid_proof', status: 403 });

    expect(erased(first)).toBe(true);
    expect(fx.state.pendingVaultEnrollments.size).toBe(0);
    await expect(fx.commit()).rejects.toMatchObject({ code: 'invalid_operation', status: 409 });
  });
});

/** Pool client double: records statements and how it was released; can fail chosen statements. */
class FlakyClient {
  readonly log: string[] = [];
  readonly releasedWith: unknown[][] = [];
  constructor(private readonly failing: Record<string, Error>) {}
  async query(sql: string) {
    this.log.push(sql.split(' ')[0]);
    const failure = Object.entries(this.failing).find(([statement]) => sql.startsWith(statement));
    if (failure) throw failure[1];
    return { rows: [], rowCount: 0 };
  }
  release(...args: unknown[]): void { this.releasedWith.push(args) }
}

describe('Files key-bundle transaction when ROLLBACK itself fails', () => {
  it('rethrows the original work error and releases the client with the rollback error so the pool destroys it', async() => { // risk: custody error masked; poisoned connection (open txn + advisory lock) reused
    const rollbackError = new Error('connection terminated');
    const client = new FlakyClient({ ROLLBACK: rollbackError });
    const repository = new PostgresFilesKeyBundleRepository({ connect: async() => client } as unknown as Database);

    await expect(repository.withCollectionLock('p', 'c', async() => { throw new Error('custody conflict') })).rejects.toThrow('custody conflict');

    expect(client.log).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(client.releasedWith).toEqual([[rollbackError]]);
  });

  it('returns a healthy client to the pool after a clean rollback', async() => { // risk: every failed custody write destroys a pool connection
    const client = new FlakyClient({});
    const repository = new PostgresFilesKeyBundleRepository({ connect: async() => client } as unknown as Database);

    await expect(repository.withCollectionLock('p', 'c', async() => { throw new Error('custody conflict') })).rejects.toThrow('custody conflict');

    expect(client.releasedWith).toHaveLength(1);
    expect(client.releasedWith[0][0]).toBeUndefined();
  });
});
