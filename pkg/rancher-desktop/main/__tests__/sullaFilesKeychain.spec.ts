/** @jest-environment node */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { SullaFilesKeychain, type FilesSafeStorage } from '../sullaFilesKeychain';

// Synthetic encryption provider: tests never access Electron or a real keychain.
function storage(): FilesSafeStorage {
  const wrappingKey = crypto.randomBytes(32);
  return {
    isEncryptionAvailable:     () => true,
    getSelectedStorageBackend: () => 'test',
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
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

describe('Files keychain bootstrap', () => {
  let directory: string;
  let keyPath: string;
  beforeEach(async() => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'files-keychain-test-'));
    keyPath = path.join(directory, 'master.enc');
  });
  afterEach(async() => { await fs.promises.rm(directory, { recursive: true, force: true }) });

  it('persists only ciphertext, reopens the same key, and wipes transient buffers', async() => {
    const provider = storage();
    let retained: Buffer | undefined;
    let original: Buffer | undefined;
    const first = new SullaFilesKeychain(keyPath, () => Promise.resolve(provider), (key) => { retained = key; original = Buffer.from(key); return Promise.resolve() });
    await first.unlock();
    expect(retained?.every(byte => byte === 0)).toBe(true);
    const disk = await fs.promises.readFile(keyPath);
    expect(disk.includes(original!)).toBe(false);
    expect(disk.includes(original!.toString('base64'))).toBe(false);
    expect((await fs.promises.stat(keyPath)).mode & 0o777).toBe(0o600);
    await new SullaFilesKeychain(keyPath, () => Promise.resolve(provider), (key) => { expect(key.equals(original!)).toBe(true); return Promise.resolve() }).unlock();
    original!.fill(0);
  });

  it.each(['unavailable', 'basic_text'])('fails closed for %s without creating key material', async(mode) => {
    const provider = storage();
    provider.isEncryptionAvailable = () => mode !== 'unavailable';
    provider.getSelectedStorageBackend = () => mode;
    let invoked = false;
    await expect(new SullaFilesKeychain(keyPath, () => Promise.resolve(provider), () => { invoked = true; return Promise.resolve() }).unlock()).rejects.toThrow('Files could not unlock using the OS keychain');
    expect(invoked).toBe(false);
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('does not replace an unreadable encrypted key or expose provider errors', async() => {
    const original = Buffer.from('synthetic-invalid-ciphertext');
    await fs.promises.writeFile(keyPath, original);
    const provider = storage();
    provider.decryptString = () => { throw new Error('synthetic-secret-must-not-escape') };
    await expect(new SullaFilesKeychain(keyPath, () => Promise.resolve(provider), () => Promise.reject(new Error('must not bootstrap'))).unlock()).rejects.toThrow('Files could not unlock using the OS keychain');
    expect(await fs.promises.readFile(keyPath)).toEqual(original);
  });

  it('wipes the key on bootstrap failure and coalesces concurrent unlocks', async() => {
    let retained: Buffer | undefined;
    let calls = 0;
    const keychain = new SullaFilesKeychain(keyPath, () => Promise.resolve(storage()), (key) => { calls++; retained = key; return Promise.reject(new Error('synthetic request failure')) });
    const results = await Promise.allSettled([keychain.unlock(), keychain.unlock()]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(calls).toBe(1);
    expect(retained?.every(byte => byte === 0)).toBe(true);
  });
  it('allows lock to wait for bootstrap completion and plaintext zeroization', async() => {
    let release!: () => void;
    let began!: () => void;
    const entered = new Promise<void>(resolve => { began = resolve });
    const held = new Promise<void>(resolve => { release = resolve });
    let retained: Buffer | undefined;
    const keychain = new SullaFilesKeychain(keyPath, () => Promise.resolve(storage()), async(key) => { retained = key; began(); await held });
    const unlock = keychain.unlock();
    await entered;
    let drained = false;
    const settled = keychain.settled().then(() => { drained = true; expect(retained?.every(byte => byte === 0)).toBe(true) });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([unlock, settled]);
    expect(drained).toBe(true);
  });
});
