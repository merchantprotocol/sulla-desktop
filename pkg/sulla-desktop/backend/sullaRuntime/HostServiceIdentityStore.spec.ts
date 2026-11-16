// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostServiceIdentityStore, type ProtectedStorage } from './HostServiceIdentityStore';

class FakeProtectedStorage implements ProtectedStorage {
  available = true;
  isEncryptionAvailable() { return this.available }
  encryptString(plainText: string) { return Buffer.from(`enc:${ plainText }`) }
  decryptString(encrypted: Buffer) {
    const text = encrypted.toString();

    if (!text.startsWith('enc:')) throw new Error('not ciphertext');

    return text.slice(4);
  }
}

describe('HostServiceIdentityStore', () => {
  let home: string;
  let storage: FakeProtectedStorage;
  let store: HostServiceIdentityStore;

  beforeEach(async() => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-store-'));
    storage = new FakeProtectedStorage();
    store = new HostServiceIdentityStore(() => storage, () => home);
  });
  afterEach(async() => {
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  // risk: permissions — identities must never be written unprotected.
  it('refuses vault identities when OS-protected storage is unavailable', async() => {
    storage.available = false;
    await expect(store.loadOrCreateVaultServiceIdentities()).rejects.toThrow('OS-protected storage is required');
    await expect(store.loadOrCreateFilesBootstrapIdentity()).rejects.toThrow('OS-protected storage is required');
  });

  it('creates five distinct vault role tokens and returns the same ones on the next start', async() => {
    const first = await store.loadOrCreateVaultServiceIdentities();

    expect(new Set(Object.values(first)).size).toBe(5);
    expect(fs.readFileSync(path.join(home, 'vault-control-token.enc'), 'utf8')).toBe(`enc:${ first.controlToken }`);
    expect((fs.statSync(path.join(home, 'vault-control-token.enc')).mode & 0o777)).toBe(0o600);
    await expect(store.loadOrCreateVaultServiceIdentities()).resolves.toEqual(first);
  });

  it('rotates every vault token when one stored token is missing or too short', async() => {
    const first = await store.loadOrCreateVaultServiceIdentities();

    fs.writeFileSync(path.join(home, 'vault-broker-token.enc'), 'enc:short');
    const second = await store.loadOrCreateVaultServiceIdentities();

    expect(second.controlToken).not.toBe(first.controlToken);
    expect(new Set(Object.values(second)).size).toBe(5);
  });

  it('keeps the Files bootstrap identity stable and rejects an invalid stored one', async() => {
    const token = await store.loadOrCreateFilesBootstrapIdentity();

    expect(Buffer.byteLength(token)).toBeGreaterThanOrEqual(32);
    await expect(store.loadOrCreateFilesBootstrapIdentity()).resolves.toBe(token);
    fs.writeFileSync(path.join(home, 'files-bootstrap-identity.enc'), 'enc:tiny');
    await expect(store.loadOrCreateFilesBootstrapIdentity()).rejects.toThrow('invalid');
  });

  it('writes the Accounts secret files 0600 in a 0700 directory and keeps existing secrets', async() => {
    const paths = await store.prepareAccountsSecrets('db-password');
    const directory = path.join(home, 'accounts');

    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(paths.databaseUsername, 'utf8')).toBe('sulla');
    expect(fs.readFileSync(paths.databasePassword, 'utf8')).toBe('db-password');
    expect(fs.readFileSync(paths.encryption).byteLength).toBe(32);
    expect(fs.readFileSync(paths.session).byteLength).toBe(48);
    expect(fs.readFileSync(paths.bootstrap, 'utf8')).toMatch(/^[A-Za-z0-9_-]{64}$/);
    for (const file of Object.values(paths)) expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const encryption = fs.readFileSync(paths.encryption);

    await store.prepareAccountsSecrets('rotated');
    expect(fs.readFileSync(paths.encryption).equals(encryption)).toBe(true);
    expect(fs.readFileSync(paths.databasePassword, 'utf8')).toBe('rotated');
  });

  // risk: data — a corrupted secret must fail loudly, never be silently replaced.
  it('rejects an existing Accounts key of the wrong length', async() => {
    await fs.promises.mkdir(path.join(home, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(home, 'accounts', 'encryption.key'), Buffer.alloc(5));
    await expect(store.prepareAccountsSecrets('pw')).rejects.toThrow('invalid length');
  });

  it('refuses a symlinked Accounts directory', async() => {
    const elsewhere = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-elsewhere-'));

    try {
      fs.symlinkSync(elsewhere, path.join(home, 'accounts'));
      await expect(store.prepareAccountsSecrets('pw')).rejects.toThrow('not a regular directory');
    } finally {
      await fs.promises.rm(elsewhere, { recursive: true, force: true });
    }
  });
});
