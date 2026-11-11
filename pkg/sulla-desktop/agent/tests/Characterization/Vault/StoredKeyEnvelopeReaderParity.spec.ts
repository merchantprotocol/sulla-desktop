// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { KeyWrap, NobleCryptoPrimitives } from '@sulla/domain';

import { StoredKeyEnvelopeReader } from '../../../../../../services/sulla-vault/src/browserEnvelope/StoredKeyEnvelopeReader';
import { StoredKeyEnvelopeReaderProvider } from '../../../../../../services/sulla-vault/src/browserEnvelope/StoredKeyEnvelopeReaderProvider';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import { loadSodium } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import {
  decryptWithKey,
  deriveMasterKey,
  encryptWithKey,
  generateKey,
  unwrapUserKey,
  unwrapUserPrivateKey,
} from '../../../../../../packages/vault-crypto/src/index';

// The Desktop vault stores users.encrypted_user_key written by packages/vault-crypto. The READ path now
// opens it with the domain KeyWrap, so both implementations must agree byte for byte in both directions.
class KeyWrapParityHarness {
  async keyWrap(): Promise<KeyWrap> {
    const crypto = new SodiumCryptoPrimitives(await loadSodium(), new NobleCryptoPrimitives());
    return new KeyWrap(crypto, crypto);
  }

  async reader(): Promise<StoredKeyEnvelopeReader> {
    return new StoredKeyEnvelopeReader(await this.keyWrap());
  }

  async failure(run: () => unknown | Promise<unknown>): Promise<boolean> {
    try { await run(); } catch { return true; }
    return false;
  }
}

const harness = new KeyWrapParityHarness();

describe('StoredKeyEnvelopeReader (domain KeyWrap) vs packages/vault-crypto', () => {
  it('opens a user-key envelope sealed by vault-crypto to the same bytes', async() => {
    // risk: data loss — an unreadable stored user key locks the owner out of the vault.
    const reader = await harness.reader();
    const master = await generateKey();
    const userKey = await generateKey();
    const envelope = await encryptWithKey(userKey, master, 'sulla:user-key:v1');
    expect(Buffer.from(reader.unwrapUserKey(envelope, master))).toEqual(Buffer.from(userKey));
    expect(Buffer.from(await unwrapUserKey(envelope, master))).toEqual(Buffer.from(userKey));
  });

  it('opens the private-key envelope sealed by vault-crypto to the same bytes', async() => {
    // risk: data loss — the private key unwraps agent-shared item keys.
    const reader = await harness.reader();
    const userKey = await generateKey();
    const privateKey = await generateKey();
    const envelope = await encryptWithKey(privateKey, userKey, 'sulla:user-private-key:v1');
    expect(Buffer.from(reader.unwrapUserPrivateKey(envelope, userKey))).toEqual(Buffer.from(privateKey));
    expect(Buffer.from(await unwrapUserPrivateKey(envelope, userKey))).toEqual(Buffer.from(privateKey));
  });

  it('opens the recovery wrap sealed by vault-crypto to the same bytes', async() => {
    // risk: data loss — recovery is the only way back in after a forgotten password.
    const reader = await harness.reader();
    const recovery = await generateKey();
    const userKey = await generateKey();
    const envelope = await encryptWithKey(userKey, recovery, 'sulla:recovery-user-key:v1');
    expect(Buffer.from(reader.unwrapRecoveryUserKey(envelope, recovery))).toEqual(Buffer.from(userKey));
    expect(Buffer.from(await decryptWithKey(envelope, recovery, 'sulla:recovery-user-key:v1'))).toEqual(Buffer.from(userKey));
  });

  it('seals with the domain KeyWrap and vault-crypto opens it, for all three AADs', async() => {
    // risk: interoperability — Cloud and Mobile seal with the domain KeyWrap and Desktop must read it back.
    const keyWrap = await harness.keyWrap();
    const key = await generateKey();
    const secret = await generateKey();
    for (const aad of [
      StoredKeyEnvelopeReader.USER_KEY_AAD,
      StoredKeyEnvelopeReader.USER_PRIVATE_KEY_AAD,
      StoredKeyEnvelopeReader.RECOVERY_USER_KEY_AAD,
    ]) {
      const envelope = keyWrap.seal(key, secret, aad);
      expect(Buffer.from(await decryptWithKey(envelope, key, aad))).toEqual(Buffer.from(secret));
      expect(Buffer.from(keyWrap.open(key, envelope, aad))).toEqual(Buffer.from(secret));
    }
  });

  it('opens the KAT fixture user key to the same bytes as vault-crypto', async() => {
    // risk: data loss — the fixture is the real envelope shape shared with the browser and Cloud.
    const kat = JSON.parse(await readFile(new URL('../../../../../../fixtures/crypto/vault-sync-v3-kat.json', import.meta.url), 'utf8')) as {
      password: string;
      desktop: { bundle: { kdf: { salt: string; memoryBytes: number; ops: number }; encryptedUserKey: Parameters<typeof unwrapUserKey>[0] } };
    };
    const { kdf, encryptedUserKey } = kat.desktop.bundle;
    const master = (await deriveMasterKey(kat.password, kdf.salt, { memoryBytes: kdf.memoryBytes, operations: kdf.ops })).key;
    const legacy = await unwrapUserKey(encryptedUserKey, master);
    const reader = await harness.reader();
    expect(Buffer.from(reader.unwrapUserKey(encryptedUserKey, master))).toEqual(Buffer.from(legacy));
  });

  it('rejects a wrong key, a wrong AAD and a foreign envelope exactly as vault-crypto does', async() => {
    // risk: permissions — a wrong password or swapped envelope must never yield key material.
    const reader = await harness.reader();
    const master = await generateKey();
    const other = await generateKey();
    const userKey = await generateKey();
    const envelope = await encryptWithKey(userKey, master, 'sulla:user-key:v1');
    const tampered = { ...envelope, version: 2 as unknown as 1 };

    expect(await harness.failure(() => reader.unwrapUserKey(envelope, other))).toBe(true);
    expect(await harness.failure(() => unwrapUserKey(envelope, other))).toBe(true);
    // AAD is domain-separated: a user-key envelope is not a private-key or recovery envelope.
    expect(await harness.failure(() => reader.unwrapUserPrivateKey(envelope, master))).toBe(true);
    expect(await harness.failure(() => reader.unwrapRecoveryUserKey(envelope, master))).toBe(true);
    expect(await harness.failure(() => unwrapUserPrivateKey(envelope, master))).toBe(true);
    expect(await harness.failure(() => reader.unwrapUserKey(tampered, master))).toBe(true);
    expect(await harness.failure(() => unwrapUserKey(tampered, master))).toBe(true);
  });

  it('the provider builds a working reader on libsodium and accepts an injected one', async() => {
    // risk: composition — the default wiring in LocalVaultAuthority must open real envelopes.
    const master = await generateKey();
    const userKey = await generateKey();
    const envelope = await encryptWithKey(userKey, master, 'sulla:user-key:v1');
    const built = await new StoredKeyEnvelopeReaderProvider().get();
    expect(Buffer.from(built.unwrapUserKey(envelope, master))).toEqual(Buffer.from(userKey));
    const injected = await harness.reader();
    expect(await new StoredKeyEnvelopeReaderProvider(injected).get()).toBe(injected);
  });
});
