import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { openVaultCacheEnvelope, sealLegacyVaultKey } from '../vaultCacheEnvelope';

describe('vault cache envelope', () => {
  test('opens only an authenticated 32-byte master cache', () => {
    const sessionKey = randomBytes(32);
    const masterKey = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ masterKey: masterKey.toString('base64url') })), cipher.final()]);
    const sealed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');

    const opened = openVaultCacheEnvelope(sealed, sessionKey);
    expect(opened.equals(masterKey)).toBe(true);
    opened.fill(0);
    expect(() => openVaultCacheEnvelope(sealed, randomBytes(32))).toThrow();

    sessionKey.fill(0); masterKey.fill(0); nonce.fill(0); ciphertext.fill(0);
  });

  test('seals the raw legacy VMK for the authenticated cache-fetch transcript', () => {
    const sessionKey = randomBytes(32);
    const legacyVmk = randomBytes(32);
    const nonce = randomBytes(12);
    const packed = Buffer.from(sealLegacyVaultKey(legacyVmk, sessionKey, nonce), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', sessionKey, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const opened = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);

    expect(packed.byteLength).toBe(60);
    expect(opened.equals(legacyVmk)).toBe(true);
    expect(() => sealLegacyVaultKey(Buffer.alloc(31), sessionKey, nonce)).toThrow();

    sessionKey.fill(0); legacyVmk.fill(0); nonce.fill(0); packed.fill(0); opened.fill(0);
  });
});
