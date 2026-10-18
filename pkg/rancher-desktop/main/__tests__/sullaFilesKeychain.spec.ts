/** @jest-environment node */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { SullaFilesKeychain, type FilesSafeStorage } from '../sullaFilesKeychain';

function storage():FilesSafeStorage {
  const wrappingKey = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test',
    encryptString(value) {
      const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

describe('isolated Files key persistence', () => {
  let directory:string; let keyPath:string;
  beforeEach(async() => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'files-keychain-test-'));
    keyPath = path.join(directory, 'master.enc');
  });
  afterEach(async() => { await fs.promises.rm(directory, { recursive: true, force: true }) });

  it('durably creates ciphertext without replacing an existing canonical master', async() => {
    const provider = storage(); const keychain = new SullaFilesKeychain(keyPath, async() => provider);
    const master = crypto.randomBytes(32); const other = crypto.randomBytes(32);
    await keychain.persistMaster(master);
    const original = await fs.promises.readFile(keyPath);
    expect(original.includes(master)).toBe(false);
    expect((await fs.promises.stat(keyPath)).mode & 0o777).toBe(0o600);
    await keychain.persistMaster(master);
    expect(await fs.promises.readFile(keyPath)).toEqual(original);
    await expect(keychain.persistMaster(other)).rejects.toThrow('appeared during bootstrap');
    expect(await fs.promises.readFile(keyPath)).toEqual(original);
    expect((await fs.promises.readdir(directory)).filter(name => name.includes('.candidate-'))).toEqual([]);
    master.fill(0); other.fill(0); original.fill(0);
  });

  it.each(['unavailable', 'basic_text'])('fails closed for %s without creating material', async(mode) => {
    const provider = storage(); provider.isEncryptionAvailable = () => mode !== 'unavailable'; provider.getSelectedStorageBackend = () => mode;
    const master = crypto.randomBytes(32);
    await expect(new SullaFilesKeychain(keyPath, async() => provider).persistMaster(master)).rejects.toThrow('Secure OS key storage is unavailable');
    expect(fs.existsSync(keyPath)).toBe(false); master.fill(0);
  });

  it('archives raw legacy material before removal and resumes the same archive idempotently', async() => {
    const provider = storage(); const sourcePath = path.join(directory, 'legacy.key'); const archivePath = path.join(directory, 'legacy.enc');
    const legacy = crypto.randomBytes(32); await fs.promises.writeFile(sourcePath, legacy);
    const keychain = new SullaFilesKeychain(keyPath, async() => provider, undefined, [{ sourcePath, archivePath }]);
    const candidates = await keychain.legacyCandidates(); expect(candidates).toHaveLength(1); expect(candidates[0]).toEqual(legacy);
    await keychain.retireConsumedLegacySources(); expect(fs.existsSync(sourcePath)).toBe(false);
    const archived = await fs.promises.readFile(archivePath); expect(archived.includes(legacy)).toBe(false);
    await fs.promises.writeFile(sourcePath, legacy); await keychain.retireConsumedLegacySources();
    expect(fs.existsSync(sourcePath)).toBe(false); expect(await fs.promises.readFile(archivePath)).toEqual(archived);
    candidates.forEach(value => value.fill(0)); legacy.fill(0); archived.fill(0);
  });

  it('preserves a raw legacy source when an existing archive conflicts', async() => {
    const provider = storage(); const sourcePath = path.join(directory, 'legacy.key'); const archivePath = path.join(directory, 'legacy.enc');
    const legacy = crypto.randomBytes(32); await fs.promises.writeFile(sourcePath, legacy);
    await fs.promises.writeFile(archivePath, provider.encryptString(crypto.randomBytes(32).toString('base64url')));
    const keychain = new SullaFilesKeychain(keyPath, async() => provider, undefined, [{ sourcePath, archivePath }]);
    await expect(keychain.retireConsumedLegacySources()).rejects.toThrow('archive conflict');
    expect(await fs.promises.readFile(sourcePath)).toEqual(legacy); legacy.fill(0);
  });

  it('does not remove a same-inode legacy source rewritten during archival', async() => {
    const provider = storage(); const sourcePath = path.join(directory, 'legacy.key'); const archivePath = path.join(directory, 'legacy.enc');
    const legacy = crypto.randomBytes(32); const replacement = crypto.randomBytes(32); await fs.promises.writeFile(sourcePath, legacy);
    const encrypt = provider.encryptString.bind(provider);
    provider.encryptString = (value) => { fs.writeFileSync(sourcePath, replacement); return encrypt(value) };
    const keychain = new SullaFilesKeychain(keyPath, async() => provider, undefined, [{ sourcePath, archivePath }]);
    await expect(keychain.retireConsumedLegacySources()).rejects.toThrow('changed during archival');
    expect(await fs.promises.readFile(sourcePath)).toEqual(replacement); legacy.fill(0); replacement.fill(0);
  });
});
