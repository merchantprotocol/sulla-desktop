// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 (S4a follow-up): staged device-enrollment keys never outlive a lock or their 60 s TTL, a
// commit never unlocks a vault the user locked meanwhile, and every unwrapped key copy is zeroed.
// Real LocalVaultAuthority + real transport envelope crypto; the database is a synthetic "no vault
// yet" double, the bundle codec, stored-key reader and commit transaction are doubles.
// (The ROLLBACK-failure transaction specs live in PgTransactionRunner.spec.ts.)
//
// Fail on main (before this change): lock mid-adopt, TTL purge, commit purge, failed repeat adopt,
// both commit-lock races, the three unwrapped-user-key cases (no pooled copy; wrong length is not
// zeroed) and the wrong-length master key. Guards that pass on main and keep the fix from
// over-reaching: "no lock" adopt, repeat-adopt TTL restart and the unlocked commit.

import { webcrypto } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesTransportEnvelopeService } from '@sulla/vault-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';

const TOKENS = { bootstrap: 'b'.repeat(40), control: 'c'.repeat(40), approval: 'a'.repeat(40), broker: 'r'.repeat(40), files: 'f'.repeat(40) };
const USER_ID = 'e10a0000-0000-4000-8000-000000000011';
const VAULT_ID = 'e10b0000-0000-4000-8000-000000000012';
const REQUEST_ID = 'e10c0000-0000-4000-8000-000000000013';
/** A well-formed request id that is not REQUEST_ID: an envelope bound to it fails proof verification. */
const OTHER_REQUEST_ID = 'e10c0000-0000-4000-8000-000000000014';
const TTL_MS = 60_000;
const subtle = webcrypto.subtle;

type Staged = { expiresAt: number; userKey: Uint8Array; privateKey: Uint8Array; masterKey: Uint8Array; bundle: unknown; head: unknown; cloudUserId: string };

/** Collaborator-only authority state, reached by name on purpose. */
interface AuthorityState {
  pendingVaultEnrollments: Map<string, Staged>;
  codecProvider: { get(): Promise<{ verifyBundle(bundle: unknown, userKey: Uint8Array): void }> };
  keys: { userKey: Uint8Array } | null;
  migrationState: string;
  stagedCacheUpdate: { masterKey: Uint8Array } | null;
  isSetupRequired(): Promise<boolean>;
  runTransaction(operation: unknown): Promise<unknown>;
}

const zeroed = (bytes: Uint8Array) => bytes.every(byte => byte === 0);
const erased = (staged: Staged) => [staged.userKey, staged.privateKey, staged.masterKey].every(zeroed);

class Deferred {
  release!: () => void;
  readonly promise = new Promise<void>(resolve => { this.release = resolve });
}

/**
 * Stored-key reader double; the gate, when armed, holds the private-key unwrap until released.
 * `requested` resolves the moment adopt asks for the private key, so a spec can await that point
 * explicitly instead of guessing how many event-loop turns the real WebCrypto unwrap takes.
 */
class KeyReader {
  readonly privateKeysHandedOut: Uint8Array[] = [];
  readonly userKeysHandedOut: Uint8Array[] = [];
  /** What the stored bundle decrypts to; defaults to the enrollment's own user key. */
  bundleUserKey: Uint8Array;
  readonly requested = new Deferred();
  gate: Deferred | undefined;
  private calls = 0;

  constructor(userKey: Uint8Array, private readonly privateKey: Uint8Array) { this.bundleUserKey = userKey }

  async get() {
    this.calls += 1;
    if (this.calls % 2 === 0 && this.gate) {
      this.requested.release();
      await this.gate.promise;
    }
    return {
      unwrapUserKey: () => {
        const copy = Uint8Array.from(this.bundleUserKey);
        this.userKeysHandedOut.push(copy);
        return copy;
      },
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
  async adopt(requestId = REQUEST_ID, wrappedFor = requestId, masterKey = Buffer.alloc(32, 0x73).toString('base64url')): Promise<{ bundleMac: string; headMac: string }> {
    const payload = new TextEncoder().encode(JSON.stringify({ userKey: Buffer.from(this.userKey).toString('base64url'), bundle: this.bundle, head: this.head }));
    const wrappedUserKey = await this.transport.wrap(payload, this.publicKey, wrappedFor, VAULT_ID, 1);
    return this.authority.adoptVaultEnrollment('approval', TOKENS.approval, {
      requestId, vaultId: VAULT_ID, vaultEpoch: 1, privateKeyJwk: this.privateKeyJwk, wrappedUserKey,
      masterKey, cloudUserId: 'cloud-user-e10',
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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() });

describe('Adopting a device enrollment never stages keys after a lock', () => {
  it('a lock while adopt awaits the key reader fails with 423, stages nothing and zeroes the unwrapped key', async() => { // risk: staged enrollment keys survive a lock (TOCTOU)
    const fx = await new AdoptFixture().setup();
    fx.reader.gate = new Deferred();
    const pending = fx.adopt();
    // Wait until adopt is parked in the key reader; if adopt settles first, fail instead of hanging.
    const reached = await Promise.race([
      fx.reader.requested.promise.then(() => 'key reader' as const),
      pending.then(() => 'resolved' as const, () => 'rejected' as const),
    ]);
    expect(reached).toBe('key reader');

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
    expect(erased(first)).toBe(false);

    // Valid request id, but the envelope is bound to another request: it fails at proof verification.
    await expect(fx.adopt(REQUEST_ID, OTHER_REQUEST_ID)).rejects.toMatchObject({ code: 'invalid_proof', status: 403 });

    expect(erased(first)).toBe(true);
    expect(fx.state.pendingVaultEnrollments.size).toBe(0);
    await expect(fx.commit()).rejects.toMatchObject({ code: 'invalid_operation', status: 409 });
  });
});

/** Holds one overridden authority step open until released, and says when it was reached. */
class GatedStep {
  readonly reached = new Deferred();
  readonly gate = new Deferred();
  calls = 0;

  async run<T>(result: T): Promise<T> {
    this.calls += 1;
    this.reached.release();
    await this.gate.promise;
    return result;
  }
}

/** Waits until `step` is reached; if `pending` settles first, fails instead of hanging. */
async function parkedAt(step: GatedStep, pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    step.reached.promise.then(() => 'parked'),
    pending.then(() => 'resolved', () => 'rejected'),
  ]);
}

describe('Committing an enrollment never unlocks a vault the user locked meanwhile', () => {
  it('a lock while the commit transaction is pending fails with 423, keeps the vault locked and zeroes the staged keys', async() => { // risk: vault left unlocked after the user locked it
    const fx = await new AdoptFixture().setup();
    await fx.adopt();
    const staged = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    const transaction = new GatedStep();
    fx.state.runTransaction = () => transaction.run(undefined);

    const pending = fx.commit();
    expect(await parkedAt(transaction, pending)).toBe('parked');
    fx.authority.lockNow();
    transaction.gate.release();

    await expect(pending).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
    expect(transaction.calls).toBe(1); // the lock landed after COMMIT: the rows stay (the user unlocks them with the password), the keys never load
    expect(fx.state.keys).toBeNull();
    expect(fx.state.migrationState).toBe('locked');
    expect(fx.state.stagedCacheUpdate).toBeNull();
    expect(erased(staged)).toBe(true);
  });

  it('a lock before the transaction starts writes no rows and fails with 423', async() => { // risk: vault rows written and unlocked after a lock
    const fx = await new AdoptFixture().setup();
    await fx.adopt();
    const staged = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    const setupCheck = new GatedStep();
    fx.state.isSetupRequired = () => setupCheck.run(true);
    let transactions = 0;
    fx.state.runTransaction = async() => { transactions += 1 };

    const pending = fx.commit();
    expect(await parkedAt(setupCheck, pending)).toBe('parked');
    fx.authority.lockNow();
    setupCheck.gate.release();

    await expect(pending).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
    expect(transactions).toBe(0);
    expect(fx.state.keys).toBeNull();
    expect(erased(staged)).toBe(true);
  });

  it('still unlocks the adopted vault when no lock happens', async() => { // risk: the lock guard refuses every enrollment commit
    const fx = await new AdoptFixture().setup();
    await fx.adopt();
    const staged = fx.state.pendingVaultEnrollments.get(REQUEST_ID)!;
    fx.state.runTransaction = async() => undefined;

    await expect(fx.commit()).resolves.toEqual({ adopted: true });
    expect(fx.state.migrationState).toBe('unlocked');
    expect(fx.state.keys?.userKey.every(byte => byte === 0x71)).toBe(true);
    expect(erased(staged)).toBe(true);
  });
});

describe('Adopt zeroes every unwrapped key copy', () => {
  const cases = [
    { name: 'matches', bundleUserKey: new Uint8Array(32).fill(0x71), outcome: 'resolves' },
    { name: 'does not match', bundleUserKey: new Uint8Array(32).fill(0x55), outcome: 'invalid_proof' },
    { name: 'has the wrong length', bundleUserKey: new Uint8Array(16).fill(0x71), outcome: 'invalid_proof' },
  ] as const;

  it.each(cases)('the bundle user key is zeroed and never copied into the Buffer pool when it $name', async({ bundleUserKey, outcome }) => { // risk: user key left readable in process memory
    const fx = await new AdoptFixture().setup();
    fx.reader.bundleUserKey = bundleUserKey;
    const from = vi.spyOn(Buffer, 'from');

    const adopted = fx.adopt();
    if (outcome === 'resolves') await expect(adopted).resolves.toEqual({ bundleMac: 'bundle-mac', headMac: 'head-mac' });
    else await expect(adopted).rejects.toMatchObject({ code: 'invalid_proof', status: 403 });

    expect(fx.reader.userKeysHandedOut).toHaveLength(1);
    const handedOut = fx.reader.userKeysHandedOut[0];
    expect(zeroed(handedOut)).toBe(true);
    expect(from.mock.calls.some(([source]) => source === handedOut)).toBe(false);
  });

  it('a wrong-length master key is rejected with 400 and zeroed', async() => { // risk: account master key bytes left in memory
    const fx = await new AdoptFixture().setup();
    const shortKey = Buffer.alloc(31, 0x73).toString('base64url');
    const from = vi.spyOn(Buffer, 'from');

    await expect(fx.adopt(REQUEST_ID, REQUEST_ID, shortKey)).rejects.toMatchObject({ code: 'invalid_unlock_material', status: 400 });

    const index = from.mock.calls.findIndex(([source, encoding]) => source === shortKey && encoding === 'base64url');
    expect(index).toBeGreaterThanOrEqual(0);
    const decoded = from.mock.results[index].value as Buffer;
    expect(decoded.byteLength).toBe(31);
    expect(zeroed(decoded)).toBe(true);
    expect(fx.state.pendingVaultEnrollments.size).toBe(0);
  });
});
