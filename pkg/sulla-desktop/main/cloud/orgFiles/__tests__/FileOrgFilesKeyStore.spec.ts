import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileOrgFilesKeyStore, type OrgFilesProtectedStorage } from '../../device/FileOrgFilesKeyStore';

class FakeProtectedStorage implements OrgFilesProtectedStorage {
  constructor(private readonly available = true) {}
  isEncryptionAvailable(): boolean { return this.available; }
  encryptString(value: string): Buffer { return Buffer.from(`wrapped:${value}`, 'utf8'); }
  decryptString(value: Buffer): string {
    const text = value.toString('utf8');
    if (!text.startsWith('wrapped:')) throw new Error('bad fake wrap');
    return text.slice('wrapped:'.length);
  }
}

describe('FileOrgFilesKeyStore', () => {
  const directories: string[] = [];
  const makeDirectory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'org-files-key-'));
    directories.push(directory);
    return directory;
  };
  const digestFor = (userId: string, orgId: string) => createHash('sha256').update(`${userId}|${orgId}`).digest('hex');
  const itemKey = 'org-files-recipient:user-1:org-1';
  const privateJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y', d: 'synthetic-private-key' };
  afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('encrypts and round-trips the JWK without exposing private material', async () => {
    // risk: private-key custody — private JWK bytes must never be persisted in plaintext.
    const directory = makeDirectory();
    const store = new FileOrgFilesKeyStore(() => new FakeProtectedStorage(), () => directory);
    await store.write(itemKey, privateJwk);
    const filePath = path.join(directory, 'org-files-keys', `${digestFor('user-1', 'org-1')}.enc`);
    const bytes = fs.readFileSync(filePath, 'utf8');
    expect(bytes).not.toContain(privateJwk.d);
    expect(bytes).not.toContain('"d":');
    expect(await store.read(itemKey)).toEqual(privateJwk);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    const envelope = JSON.parse(bytes);
    expect(envelope).toEqual(expect.objectContaining({ v: 1, nonce: expect.any(String), ct: expect.any(String), tag: expect.any(String), wrappedDataKey: expect.any(String) }));
  });

  it('authenticates user and org identity as AES-GCM associated data', async () => {
    // risk: tenant isolation — ciphertext copied under a different identity must not decrypt.
    const directory = makeDirectory();
    const store = new FileOrgFilesKeyStore(() => new FakeProtectedStorage(), () => directory);
    await store.write(itemKey, privateJwk);
    const original = path.join(directory, 'org-files-keys', `${digestFor('user-1', 'org-1')}.enc`);
    const alternate = path.join(directory, 'org-files-keys', `${digestFor('user-2', 'org-2')}.enc`);
    fs.copyFileSync(original, alternate);
    await expect(store.read('org-files-recipient:user-2:org-2')).rejects.toThrow();
  });

  it('fails closed without OS-protected storage and creates no files', async () => {
    // risk: private-key custody — unavailable OS encryption may never fall back to plaintext.
    const directory = makeDirectory();
    const store = new FileOrgFilesKeyStore(() => new FakeProtectedStorage(false), () => directory);
    await expect(store.write(itemKey, privateJwk)).rejects.toThrow('OS-protected storage is required');
    expect(fs.existsSync(path.join(directory, 'org-files-keys'))).toBe(false);
  });

  it('migrates a legacy plaintext file into ciphertext and removes the plaintext', async () => {
    // risk: private-key custody — existing plaintext private keys must be migrated and erased.
    const directory = makeDirectory();
    const folder = path.join(directory, 'org-files-keys');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const legacyPath = path.join(folder, `${digestFor('user-1', 'org-1')}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify({ v: 1, privateJwk }));
    const store = new FileOrgFilesKeyStore(() => new FakeProtectedStorage(), () => directory);
    expect(await store.read(itemKey)).toEqual(privateJwk);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(path.join(folder, `${digestFor('user-1', 'org-1')}.enc`))).toBe(true);
  });
});
