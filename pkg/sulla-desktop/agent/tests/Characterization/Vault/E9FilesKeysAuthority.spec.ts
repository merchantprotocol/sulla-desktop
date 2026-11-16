// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 Files keys: characterization of VaultFilesKeyBundleAuthority. The same
// scripted sequence runs against the frozen legacy copy (own PGlite database)
// and the live module (own PGlite database); every outcome, every error field
// and both key bundle tables must stay identical after every step.

import {
  generateX25519RecipientKeyPair,
  openFilesKeyBundle,
  sealFilesKeyBundle,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
  type X25519RecipientKeyPair,
} from '@sulla/vault-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  VaultFilesKeyBundleAuthority,
  filesKeyBundleAuthorityTestHooks,
  type FilesAuthorityIdentityLease,
  type UnlockedFilesAuthorityIdentity,
} from '../../../../../../services/sulla-vault/src/filesKeyBundleAuthority';
import * as legacy from '../../Support/E9Legacy/filesKeyBundleAuthority.legacy';
import { E9Outcome } from '../../Support/E9Legacy/E9FilesKeysOutcome';
import { E9VaultTestDatabase } from '../../Support/E9Legacy/E9FilesKeysDatabase';

const PRINCIPAL = 'principal-e9';

/** Lends an erasable private key copy; can be told to fail the Nth generation check from now. */
class ScriptedLease implements FilesAuthorityIdentityLease {
  assertCalls = 0;
  private failAt = 0;

  constructor(private readonly principalId: string, private readonly keys: X25519RecipientKeyPair, private readonly generation = 7) {}

  failNthAssertFromNow(n: number): void { this.failAt = this.assertCalls + n }
  clearFailure(): void { this.failAt = 0 }

  async withUnlockedIdentity<T>(operation: (identity: UnlockedFilesAuthorityIdentity) => Promise<T>): Promise<T> {
    const privateKey = new Uint8Array(this.keys.privateKey);
    try {
      return await operation({
        principalId:   this.principalId,
        publicKey:     this.keys.publicKey,
        privateKey,
        generation:    this.generation,
        assertCurrent: () => {
          this.assertCalls += 1;
          if (this.assertCalls === this.failAt) throw new Error('Vault generation changed');
        },
      });
    } finally {
      privateKey.fill(0);
    }
  }
}

interface AuthorityLike {
  unlockedPrincipal(): Promise<unknown>;
  custodyRecipient(context: FilesKeyBundleContext): Promise<unknown>;
  registerBundle(bundle: { context: FilesKeyBundleContext; authorityKeyId: string; envelope: FilesKeyBundleEnvelope }): Promise<void>;
  authorizeDeviceRecovery(request: { context: FilesKeyBundleContext; devicePublicKey: string }): Promise<FilesKeyBundleEnvelope>;
}

class Side {
  readonly database = new E9VaultTestDatabase();
  lease!: ScriptedLease;
  otherLease!: ScriptedLease;
  authority!: AuthorityLike;
  otherKeyAuthority!: AuthorityLike;

  constructor(private readonly build: (db: E9VaultTestDatabase['db'], lease: FilesAuthorityIdentityLease) => AuthorityLike) {}

  async setup(keys: X25519RecipientKeyPair, otherKeys: X25519RecipientKeyPair): Promise<void> {
    await this.database.setup();
    this.lease = new ScriptedLease(PRINCIPAL, keys);
    this.otherLease = new ScriptedLease(PRINCIPAL, otherKeys);
    this.authority = this.build(this.database.db, this.lease);
    this.otherKeyAuthority = this.build(this.database.db, this.otherLease);
  }
}

class Fixture {
  keys!: X25519RecipientKeyPair;
  otherKeys!: X25519RecipientKeyPair;
  device!: X25519RecipientKeyPair;
  keyId!: string;
  readonly envelopes = new Map<string, FilesKeyBundleEnvelope>();
  readonly legacySide = new Side((db, lease) => new legacy.VaultFilesKeyBundleAuthority(db, lease));
  readonly nextSide = new Side((db, lease) => new VaultFilesKeyBundleAuthority(db, lease));

  ctx(keyVersion: number, epoch: number, collectionId = 'col-a', principalId = PRINCIPAL): FilesKeyBundleContext {
    return { principalId, collectionId, keyVersion, epoch };
  }

  material(seed: number): { dataKey: Uint8Array; dedupKey: Uint8Array } {
    return { dataKey: new Uint8Array(32).fill(seed), dedupKey: new Uint8Array(32).fill(seed + 100) };
  }

  envelope(name: string): FilesKeyBundleEnvelope {
    const envelope = this.envelopes.get(name);
    if (!envelope) throw new Error(`missing envelope ${ name }`);
    return envelope;
  }

  async setup(): Promise<void> {
    this.keys = await generateX25519RecipientKeyPair();
    this.otherKeys = await generateX25519RecipientKeyPair();
    this.device = await generateX25519RecipientKeyPair();
    this.keyId = filesKeyBundleAuthorityTestHooks.authorityKeyId({ principalId: PRINCIPAL, publicKey: this.keys.publicKey });
    const seal = (material: { dataKey: Uint8Array; dedupKey: Uint8Array }, context: FilesKeyBundleContext, purpose: 'authority-custody' | 'device-recovery' = 'authority-custody', recipient = this.keys.publicKey) =>
      sealFilesKeyBundle(material, context, purpose, recipient);
    this.envelopes.set('a11', await seal(this.material(1), this.ctx(1, 1)));
    this.envelopes.set('a11-reseal', await seal(this.material(1), this.ctx(1, 1)));
    this.envelopes.set('a21', await seal(this.material(2), this.ctx(2, 1)));
    this.envelopes.set('a12', await seal(this.material(3), this.ctx(1, 2)));
    this.envelopes.set('a22', await seal(this.material(4), this.ctx(2, 2)));
    this.envelopes.set('a32', await seal(this.material(5), this.ctx(3, 2)));
    this.envelopes.set('a33-device', await seal(this.material(6), this.ctx(3, 3), 'device-recovery'));
    this.envelopes.set('a44-foreign', await seal(this.material(7), this.ctx(4, 4), 'authority-custody', this.otherKeys.publicKey));
    this.envelopes.set('b11', await seal(this.material(8), this.ctx(1, 1, 'col-b')));
    this.envelopes.set('other-principal', await seal(this.material(9), this.ctx(1, 1, 'col-a', 'someone-else')));
    await this.legacySide.setup(this.keys, this.otherKeys);
    await this.nextSide.setup(this.keys, this.otherKeys);
  }

  /** Device envelopes are freshly randomised; compare what the device can open instead of ciphertext. */
  async describeDeviceEnvelope(outcome: Record<string, unknown>, context: FilesKeyBundleContext): Promise<Record<string, unknown>> {
    if (!outcome.ok) return outcome;
    const envelope = outcome.value as FilesKeyBundleEnvelope;
    const material = await openFilesKeyBundle(envelope, context, 'device-recovery', this.device.publicKey, this.device.privateKey);
    return {
      ok:        true,
      version:   envelope.version,
      algorithm: envelope.algorithm,
      purpose:   envelope.purpose,
      context:   envelope.context,
      keys:      Object.keys(envelope).sort(),
      dataKey:   Buffer.from(material.dataKey).toString('hex'),
      dedupKey:  Buffer.from(material.dedupKey).toString('hex'),
    };
  }

  /** Runs one step on both sides; asserts identical outcome and identical tables afterwards. */
  async both(step: (side: Side) => Promise<unknown>): Promise<Record<string, unknown>> {
    const legacyOutcome = await E9Outcome.of(() => step(this.legacySide));
    const nextOutcome = await E9Outcome.of(() => step(this.nextSide));
    expect(nextOutcome).toEqual(legacyOutcome);
    expect(await this.nextSide.database.filesKeyBundleTables()).toEqual(await this.legacySide.database.filesKeyBundleTables());
    return nextOutcome;
  }
}

const fx = new Fixture();
beforeAll(async() => { await fx.setup() }, 60_000);
afterAll(async() => {
  await fx.legacySide.database.close();
  await fx.nextSide.database.close();
});

describe.sequential('E9 Files keys: VaultFilesKeyBundleAuthority equivalence (legacy copy vs live)', () => {
  it('derives the same authority key id as the legacy helper', () => { // risk: custody key identity drift breaks every recovery
    const inputs = [
      { principalId: PRINCIPAL, publicKey: fx.keys.publicKey },
      { principalId: 'p', publicKey: 'AAAA' },
      { principalId: 'unicode-é', publicKey: '' },
    ];
    for (const input of inputs) {
      expect(filesKeyBundleAuthorityTestHooks.authorityKeyId(input)).toBe(legacy.filesKeyBundleAuthorityTestHooks.authorityKeyId(input));
    }
    expect(fx.keyId.startsWith(`vault-user-x25519:v1:${ PRINCIPAL }:`)).toBe(true);
  });

  it('reports the unlocked principal and custody recipient identically', async() => { // risk: wrong recipient seals keys to the wrong identity
    const principal = await fx.both(side => side.authority.unlockedPrincipal());
    expect(principal).toEqual({ ok: true, value: { principalId: PRINCIPAL, generation: 7 } });
    const recipient = await fx.both(side => side.authority.custodyRecipient(fx.ctx(1, 1)));
    expect(recipient).toEqual({ ok: true, value: { keyId: fx.keyId, publicKey: fx.keys.publicKey } });
    const denied = await fx.both(side => side.authority.custodyRecipient(fx.ctx(1, 1, 'col-a', 'someone-else')));
    expect(denied).toMatchObject({ ok: false, code: 'principal_denied', status: 403 });
    for (const bad of [null, fx.ctx(0, 1), fx.ctx(1, 0), fx.ctx(1.5, 1), { ...fx.ctx(1, 1), collectionId: '' }, { ...fx.ctx(1, 1), principalId: 5 }]) {
      const invalid = await fx.both(side => side.authority.custodyRecipient(bad as unknown as FilesKeyBundleContext));
      expect(invalid).toMatchObject({ ok: false, code: 'invalid_context', status: 400, message: 'Files key bundle context is invalid' });
    }
  });

  it('registers, replays, rejects and advances custody bundles identically', async() => { // risk: key custody corruption or rollback
    const register = (name: string, context: FilesKeyBundleContext, authorityKeyId = fx.keyId) =>
      (side: Side) => side.authority.registerBundle({ context, authorityKeyId, envelope: fx.envelope(name) });

    expect(await fx.both(register('a11', fx.ctx(1, 1)))).toEqual({ ok: true, value: undefined });
    expect(await fx.both(register('a11', fx.ctx(1, 1)))).toEqual({ ok: true, value: undefined });
    expect(await fx.both(register('a11-reseal', fx.ctx(1, 1)))).toMatchObject({ ok: false, code: 'bundle_conflict', status: 409 });
    expect(await fx.both(register('a11', fx.ctx(1, 1), 'wrong-key-id'))).toMatchObject({ ok: false, code: 'invalid_bundle', status: 400 });
    expect(await fx.both(register('a33-device', fx.ctx(3, 3)))).toMatchObject({ ok: false, code: 'invalid_bundle' });
    expect(await fx.both(register('a21', fx.ctx(2, 2)))).toMatchObject({ ok: false, code: 'invalid_bundle' });
    expect(await fx.both(register('other-principal', fx.ctx(1, 1, 'col-a', 'someone-else')))).toMatchObject({ ok: false, code: 'principal_denied' });
    expect(await fx.both(register('a11', fx.ctx(0, 1)))).toMatchObject({ ok: false, code: 'invalid_context' });
    expect(await fx.both(register('a44-foreign', fx.ctx(4, 4)))).toMatchObject({ ok: false });
    expect(await fx.both(side => side.otherKeyAuthority.registerBundle({ context: fx.ctx(1, 1), authorityKeyId: fx.keyId, envelope: fx.envelope('a11') })))
      .toMatchObject({ ok: false, code: 'invalid_bundle' });

    expect(await fx.both(register('a21', fx.ctx(2, 1)))).toEqual({ ok: true, value: undefined });
    expect(await fx.both(register('a12', fx.ctx(1, 2)))).toMatchObject({ ok: false, code: 'stale_context', status: 409, message: 'Files custody bundle version or epoch is stale' });
    expect(await fx.both(register('a11', fx.ctx(1, 1)))).toMatchObject({ ok: false, code: 'stale_context', status: 409, message: 'Files custody bundle is not the current authorized generation' });
    expect(await fx.both(register('a21', fx.ctx(2, 1)))).toEqual({ ok: true, value: undefined });
    expect(await fx.both(register('a22', fx.ctx(2, 2)))).toEqual({ ok: true, value: undefined });
    expect(await fx.both(register('a21', fx.ctx(2, 1)))).toMatchObject({ ok: false, code: 'stale_context', message: 'Files custody bundle is not the current authorized generation' });
    expect(await fx.both(register('b11', fx.ctx(1, 1, 'col-b')))).toEqual({ ok: true, value: undefined });
  });

  it('rolls back when the Vault generation changes before COMMIT and fails fast before any query', async() => { // risk: stale identity commits key custody
    const failing = (n: number) => async(side: Side) => {
      side.lease.failNthAssertFromNow(n);
      try {
        return await side.authority.registerBundle({ context: fx.ctx(3, 2), authorityKeyId: fx.keyId, envelope: fx.envelope('a32') });
      } finally { side.lease.clearFailure() }
    };
    for (const n of [1, 2, 3]) {
      expect(await fx.both(failing(n))).toMatchObject({ ok: false, type: 'Error', message: 'Vault generation changed' });
    }
    const tables = await fx.nextSide.database.filesKeyBundleTables();
    expect(tables.current).toContainEqual({ principal_id: PRINCIPAL, collection_id: 'col-a', key_version: '2', key_epoch: '2' });
    expect(tables.envelopes.some(row => (row as { key_version: string }).key_version === '3')).toBe(false);
    expect(await fx.both(side => side.authority.registerBundle({ context: fx.ctx(3, 2), authorityKeyId: fx.keyId, envelope: fx.envelope('a32') })))
      .toEqual({ ok: true, value: undefined });
    expect(fx.nextSide.lease.assertCalls).toBe(fx.legacySide.lease.assertCalls);
  });

  it('authorizes device recovery only for the exact current context and custody key', async() => { // risk: recovery leaks keys of another context
    const recover = (context: FilesKeyBundleContext, devicePublicKey: unknown = fx.device.publicKey, otherKey = false) => async(side: Side) => {
      const authority = otherKey ? side.otherKeyAuthority : side.authority;
      const outcome = await E9Outcome.of(() => authority.authorizeDeviceRecovery({ context, devicePublicKey: devicePublicKey as string }));
      return fx.describeDeviceEnvelope(outcome, context);
    };
    const current = await fx.both(recover(fx.ctx(3, 2)));
    expect(current).toEqual({ ok: true, value: expect.objectContaining({ ok: true, purpose: 'device-recovery', dataKey: '05'.repeat(32), dedupKey: '69'.repeat(32) }) });
    expect(await fx.both(recover(fx.ctx(1, 1, 'col-b')))).toEqual({ ok: true, value: expect.objectContaining({ ok: true, dataKey: '08'.repeat(32) }) });
    expect(await fx.both(recover(fx.ctx(2, 2)))).toEqual({ ok: true, value: expect.objectContaining({ ok: false, code: 'context_denied', status: 403 }) });
    expect(await fx.both(recover(fx.ctx(1, 1, 'col-missing')))).toEqual({ ok: true, value: expect.objectContaining({ ok: false, code: 'context_denied' }) });
    expect(await fx.both(recover(fx.ctx(3, 2), fx.device.publicKey, true))).toEqual({ ok: true, value: expect.objectContaining({ ok: false, code: 'context_denied' }) });
    expect(await fx.both(recover(fx.ctx(3, 2), ''))).toEqual({ ok: true, value: expect.objectContaining({ ok: false, code: 'invalid_device_key', status: 400 }) });
    expect(await fx.both(recover(fx.ctx(3, 2), 42))).toEqual({ ok: true, value: expect.objectContaining({ ok: false, code: 'invalid_device_key' }) });
    expect(await fx.both(recover(fx.ctx(3, 2, 'col-a', 'someone-else')))).toEqual({ ok: true, value: expect.objectContaining({ ok: false, code: 'principal_denied' }) });
    expect(await fx.both(recover(fx.ctx(3, 0)))).toEqual({ ok: true, value: expect.objectContaining({ ok: false, code: 'invalid_context' }) });
    expect(await fx.both(recover(fx.ctx(3, 2), 'not-a-key'))).toEqual({ ok: true, value: expect.objectContaining({ ok: false }) });
  });
});
