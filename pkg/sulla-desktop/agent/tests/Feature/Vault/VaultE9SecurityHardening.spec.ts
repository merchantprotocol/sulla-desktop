// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Hardening of three weaknesses the E9 security reviews found in services/sulla-vault and left in place
// because E9 had to preserve behaviour. Each case fails on a9d8542fd and passes with the fix.
// Synthetic keys and tokens only.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as auth from '../../../../../../services/sulla-vault/src/auth';
import { VaultLoginVerifier } from '../../../../../../services/sulla-vault/src/auth/VaultLoginVerifier';
import type { CloudSyncAuthority, UnlockedUserKey } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';
import type { DomainVaultSyncCodecProvider } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodecProvider';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { FilesCloudEscrowService } from '../../../../../../services/sulla-vault/src/filesCloudEscrow';
import type { VaultFilesKeyBundleAuthority } from '../../../../../../services/sulla-vault/src/filesKeyBundleAuthority';
import { createFilesKeyBundleRouter } from '../../../../../../services/sulla-vault/src/filesKeyBundleRoutes';
import { MemorySyncKeyWrap } from '../../../../../../services/sulla-vault/src/memorySyncKeyWrap';
import type { PostgresFilesCloudEscrowRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresFilesCloudEscrowRepository';
import { E9HttpHarness } from '../../Support/E9Legacy/E9FilesKeysHttpHarness';

const USER = '10000000-0000-4000-8000-0000000000e9';
const CLOUD_VAULT = '3f2e1d0c-9b8a-4c7d-b6e5-f4a3b2c1d0e9';
const FOREIGN_VAULT = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const REQUEST = '5b6c7d8e-9f0a-4b1c-9d2e-3f4a5b6c7d8e';
const RECIPIENT = 'BCrecipient';

describe('item 1: the length-following login verifier is gone', () => {
  // scrypt(loginHash, salt, 32), Node scryptSync defaults; the same vector E9Auth.spec.ts pins.
  const loginHash = 'login-hash-text';
  const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const verifierHex = '19c66fff65f6e2972fec2b6e5bf20a06d766726fa4188633974a35f3441ecd9b';

  it('no verify path that accepts an empty or truncated stored verifier remains', () => { // risk: authentication bypass
    // On main: new VaultLoginVerifier().verify(hash, salt, new Uint8Array(0)) === true and a 16-byte prefix verified.
    expect('verify' in VaultLoginVerifier.prototype).toBe(false);
    expect('verifyLoginHash' in auth).toBe(false);
  });

  it('the writer still produces the 32-byte known-answer verifier', () => { // risk: sign-in for every new desktop account
    const made = new VaultLoginVerifier().make(loginHash, salt);
    expect(made.verifier.byteLength).toBe(32);
    expect(made.verifier.toString('hex')).toBe(verifierHex);
    expect(auth.makeLoginVerifier(loginHash, salt).verifier.toString('hex')).toBe(verifierHex);
  });
});

class CloudAuthority implements CloudSyncAuthority {
  readonly responses: { status: number; headers: Record<string, string>; body: unknown }[] = [];
  lockMode: 'open' | 'locked' | 'locks-during' = 'open';
  readonly userKey = new Uint8Array(32).fill(9);

  async withUnlockedUserKey<T>(operation: (keys: UnlockedUserKey) => Promise<T>): Promise<T> {
    if (this.lockMode === 'locked') throw Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
    const assertCurrent = () => {
      if (this.lockMode === 'locks-during') throw Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
    };
    return operation({ userId: USER, userKey: new Uint8Array(this.userKey), assertCurrent });
  }

  async sullaCloudRequest() {
    return this.responses.shift() ?? { status: 500, headers: {}, body: null };
  }

  queue(statusVaultId: string, bundleVaultId: string, epoch = 4): void {
    this.responses.push({ status: 200, headers: {}, body: { vaultId: statusVaultId } });
    this.responses.push({ status: 200, headers: {}, body: { bundle: { vaultId: bundleVaultId, epoch } } });
  }
}

class CloudCodec {
  readonly unlocked: unknown[] = [];
  async get() {
    return { unlockBundle: (bundle: unknown) => { this.unlocked.push(bundle); return new Uint8Array(32).fill(5) } };
  }
}

/** No local Cloud vault: restoreKey without a cached Cloud key ends in no_cloud_vault. */
class NoLocalCloudVault {
  async ensureSchema() {}
  async cloudVaultConfigured() { return false }
  async findSyncState() { return undefined }
}

class EscrowFixture {
  readonly authority = new CloudAuthority();
  readonly codec = new CloudCodec();
  readonly service = new FilesCloudEscrowService(
    {} as Database, this.authority, undefined, this.codec as unknown as DomainVaultSyncCodecProvider,
    new NoLocalCloudVault() as unknown as PostgresFilesCloudEscrowRepository,
  );

  /** Captures every 32-byte array zeroed through Uint8Array#fill(0), as its bytes just before zeroing. */
  zeroed(): Buffer[] {
    const seen: Buffer[] = [];
    const original = Uint8Array.prototype.fill;
    vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function(this: Uint8Array, ...args: Parameters<Uint8Array['fill']>) {
      if (args[0] === 0 && this.byteLength === 32) seen.push(Buffer.from(this));
      return original.apply(this, args);
    } as never);
    return seen;
  }
}

describe('item 2: Files Cloud escrow binds the cached key to the vault status named', () => {
  afterEach(() => { vi.restoreAllMocks() });

  it('refuses a bundle for a different vault with a typed error, before unlocking, and caches nothing', async() => { // risk: escrow key for a foreign vault
    const fx = new EscrowFixture();
    fx.authority.queue(CLOUD_VAULT, FOREIGN_VAULT);
    await expect(fx.service.unlockCloud('correct horse')).rejects.toMatchObject({ code: 'cloud_vault_mismatch', status: 409 });
    expect(fx.codec.unlocked).toEqual([]);
    // Nothing cached: restoreKey falls through to the local path instead of wrapping a foreign-vault key.
    await expect(fx.service.restoreKey(REQUEST, RECIPIENT)).rejects.toMatchObject({ code: 'no_cloud_vault', status: 409 });
  });

  it('a refused foreign bundle also clears a key cached earlier for the right vault', async() => { // risk: stale escrow key reuse
    const fx = new EscrowFixture();
    fx.authority.queue(CLOUD_VAULT, CLOUD_VAULT);
    await expect(fx.service.unlockCloud('correct horse')).resolves.toMatchObject({ unlocked: true });
    fx.authority.queue(CLOUD_VAULT, FOREIGN_VAULT);
    await expect(fx.service.unlockCloud('correct horse')).rejects.toMatchObject({ code: 'cloud_vault_mismatch' });
    await expect(fx.service.restoreKey(REQUEST, RECIPIENT)).rejects.toMatchObject({ code: 'no_cloud_vault' });
  });

  it('a bundle for the vault status named still unlocks', async() => { // risk: Cloud restore broken
    const fx = new EscrowFixture();
    fx.authority.queue(CLOUD_VAULT, CLOUD_VAULT);
    await expect(fx.service.unlockCloud('correct horse')).resolves.toMatchObject({ unlocked: true });
    expect(fx.codec.unlocked).toEqual([{ vaultId: CLOUD_VAULT, epoch: 4 }]);
  });

  it('zeroes the memory key when the vault is locked before wrapping starts', async() => { // risk: key left in memory
    const fx = new EscrowFixture();
    fx.authority.lockMode = 'locked';
    const memoryKey = Buffer.alloc(32, 0x7e);
    const zeroed = fx.zeroed();
    await expect(fx.service.wrapMemoryKey(memoryKey.toString('base64'))).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
    expect(zeroed.some(bytes => bytes.equals(memoryKey))).toBe(true);
  });

  it('zeroes the unwrapped memory key when the vault locks before the unwrap completes', async() => { // risk: key left in memory
    const fx = new EscrowFixture();
    const memoryKey = Buffer.alloc(32, 0x3c);
    const wrappedKey = await new MemorySyncKeyWrap().wrap(new Uint8Array(32).fill(9), USER, new Uint8Array(memoryKey));
    fx.authority.lockMode = 'locks-during';
    const zeroed = fx.zeroed();
    await expect(fx.service.unwrapMemoryKey(wrappedKey)).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
    expect(zeroed.some(bytes => bytes.equals(memoryKey))).toBe(true);
  });
});

describe('item 3: /v1/desktop/files requires "Bearer <token>"', () => {
  const SERVICE_ID = 'sulla-files';
  const TOKEN = 'files_' + 'h'.repeat(64);
  const authority = { unlockedPrincipal: async() => ({ principalId: 'principal-h', generation: 1 }) } as unknown as VaultFilesKeyBundleAuthority;
  const harness = new E9HttpHarness(app => { app.use('/v1/desktop/files', createFilesKeyBundleRouter(authority, { serviceId: SERVICE_ID, token: TOKEN })) });
  const principal = (authorization: string) => harness.send({ method: 'GET', path: '/v1/desktop/files/principal', headers: { 'x-sulla-service-id': SERVICE_ID, authorization } });

  beforeAll(async() => { await harness.start() });
  afterAll(async() => { await harness.stop() });

  it('refuses the bare token', async() => { // risk: service authentication without the declared scheme
    const response = await principal(TOKEN);
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_service_identity', message: 'Files service identity is invalid' });
  });

  it('accepts "Bearer <token>" (what sulla-files sends) and still refuses a wrong token', async() => { // risk: Files key exchange broken
    expect((await principal(`Bearer ${ TOKEN }`)).status).toBe(200);
    expect((await principal(`Bearer ${ TOKEN }x`)).status).toBe(401);
    expect((await principal('Bearer ')).status).toBe(401);
  });
});
