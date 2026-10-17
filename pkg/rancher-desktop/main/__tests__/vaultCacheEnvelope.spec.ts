import { createCipheriv, randomBytes } from 'node:crypto';

import { openVaultCacheEnvelope } from '../vaultCacheEnvelope';

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
});
