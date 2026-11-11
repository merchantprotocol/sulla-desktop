// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from 'node:fs/promises';

import sodium from 'libsodium-wrappers-sumo';
import { describe, expect, it } from 'vitest';
import { AccountAuth, AccountKdfPolicy, type AccountKdf, type RandomSource } from '@sulla/domain';

import { CloudAccountCredentialService } from '../../../../main/cloud/CloudAccountCredentialService';
import { SodiumAccountPrimitives } from '../../../../main/cloud/SodiumAccountPrimitives';
import { deriveAccountAuthHash, deriveMasterKey } from '../../../../../../packages/vault-crypto/src/index';

interface AccountAuthKat {
  password: string;
  kdf: AccountKdf;
  masterKeyFingerprint: string;
  authHash: string;
}

class FixedRandom implements RandomSource {
  bytes(length: number): Uint8Array { return new Uint8Array(length).fill(7); }
}

class ThrowingAuthHash extends AccountAuth {
  readonly keys: Uint8Array[] = [];
  override deriveMasterKey(password: string, kdf: AccountKdf): Uint8Array {
    const key = super.deriveMasterKey(password, kdf);
    this.keys.push(key);
    return key;
  }
  override authHash(): string { throw new Error('hash failed'); }
}

class CredentialHarness {
  async primitives(): Promise<SodiumAccountPrimitives> {
    await sodium.ready;
    return new SodiumAccountPrimitives(sodium);
  }

  async service(random: RandomSource = new FixedRandom()): Promise<CloudAccountCredentialService> {
    const primitives = await this.primitives();
    return new CloudAccountCredentialService(new AccountAuth(primitives), new AccountKdfPolicy(), random);
  }

  async kat(): Promise<AccountAuthKat> {
    const file = new URL('../../../../../../fixtures/crypto/account-auth-v1.json', import.meta.url);
    return JSON.parse(await readFile(file, 'utf8')) as AccountAuthKat;
  }

  /** The exact calls the removed deriveAccountCredential made (packages/vault-crypto). */
  async legacy(password: string, kdf: AccountKdf): Promise<{ key: Uint8Array; authHash: string }> {
    const derived = await deriveMasterKey(password, kdf.salt, { memoryBytes: kdf.memoryBytes, operations: kdf.ops });
    return { key: derived.key, authHash: await deriveAccountAuthHash(derived.key) };
  }
}

const harness = new CredentialHarness();

describe('CloudAccountCredentialService (domain AccountAuth) vs the old Desktop derivation', () => {
  it('derives the known-answer master key and authHash, byte for byte the old result', async() => {
    // risk: lockout — a different authHash means no existing Cloud account can sign in.
    const kat = await harness.kat();
    const service = await harness.service();
    const credential = await service.derive(kat.password, kat.kdf);
    const old = await harness.legacy(kat.password, kat.kdf);

    expect(credential.authHash).toBe(kat.authHash);
    expect(credential.authHash).toBe(old.authHash);
    expect(Buffer.from(credential.masterKey)).toEqual(Buffer.from(old.key));
    expect(new AccountAuth(await harness.primitives()).masterKeyFingerprint(credential.masterKey)).toBe(kat.masterKeyFingerprint);
    expect(credential.kdf).toEqual(kat.kdf);
  });

  it('keeps NFC and decomposed passwords as different keys so the legacy retry still reaches the old one', async() => {
    // risk: lockout — the NFC retry in sullaCloudAuth.ts only works if the service never normalizes.
    const kat = await harness.kat();
    const service = await harness.service();
    const composed = 'café-password';
    const decomposed = composed.normalize('NFD');
    const a = await service.derive(composed, kat.kdf);
    const b = await service.derive(decomposed, kat.kdf);
    const old = await harness.legacy(decomposed, kat.kdf);

    expect(a.authHash).not.toBe(b.authHash);
    expect(b.authHash).toBe(old.authHash);
    expect(Buffer.from(b.masterKey)).toEqual(Buffer.from(old.key));
  });

  it('issues the strict KDF with a fresh 16-byte salt for a new account, and the key matches the old derivation of it', async() => {
    // risk: lockout — registering with a KDF the server refuses, or a key the old code would not reproduce.
    const service = await harness.service();
    const credential = await service.derive('a brand new password');

    expect(new AccountKdfPolicy().parse(credential.kdf)).toEqual(credential.kdf);
    expect(credential.kdf.salt).toBe(Buffer.alloc(16, 7).toString('base64url'));
    const old = await harness.legacy('a brand new password', credential.kdf);
    expect(credential.authHash).toBe(old.authHash);
    expect(Buffer.from(credential.masterKey)).toEqual(Buffer.from(old.key));
  });

  it('refuses an empty password', async() => {
    // risk: a blank password would derive a real, guessable key.
    const kat = await harness.kat();
    await expect((await harness.service()).derive('', kat.kdf)).rejects.toThrow();
  });

  it('zeroes the master key when the authHash step fails', async() => {
    // risk: key exposure — a failed derivation must not leave key bytes in memory.
    const kat = await harness.kat();
    const auth = new ThrowingAuthHash(await harness.primitives());
    const service = new CloudAccountCredentialService(auth, new AccountKdfPolicy(), new FixedRandom());

    await expect(service.derive(kat.password, kat.kdf)).rejects.toThrow('hash failed');
    expect(auth.keys).toHaveLength(1);
    expect(auth.keys[0].every(byte => byte === 0)).toBe(true);
  });

  it('accepts only the exact KDF Cloud issues and refuses a downgrade', async() => {
    // risk: a hostile server offering a cheap KDF would let the password be brute-forced.
    const kat = await harness.kat();
    const service = await harness.service();
    expect(service.parseIssuedKdf(kat.kdf)).toEqual(kat.kdf);

    const bad: unknown[] = [
      { ...kat.kdf, memoryBytes: 8 * 1024 * 1024 },
      { ...kat.kdf, ops: 1 },
      { ...kat.kdf, alg: 'argon2i' },
      { ...kat.kdf, salt: '' },
      { ...kat.kdf, salt: 'AAEC' },
      { alg: kat.kdf.alg, memoryBytes: kat.kdf.memoryBytes, ops: kat.kdf.ops },
      null,
      'argon2id13',
    ];
    for (const value of bad) {
      expect(() => service.parseIssuedKdf(value)).toThrow('Sulla Cloud returned an unsupported account KDF.');
    }
  });
});
