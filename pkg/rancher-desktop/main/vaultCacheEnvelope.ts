import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Seals the legacy VMK for the one-use cache helper request. */
export function sealLegacyVaultKey(legacyVmk: Buffer, sessionKey: Buffer, nonce = randomBytes(12)): string {
  if (legacyVmk.byteLength !== 32 || sessionKey.byteLength !== 32 || nonce.byteLength !== 12) {
    throw new Error('Vault legacy-key envelope material has an invalid length');
  }
  let ciphertext: Buffer | undefined;
  let packed: Buffer | undefined;
  try {
    const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
    ciphertext = Buffer.concat([cipher.update(legacyVmk), cipher.final()]);
    packed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    return packed.toString('base64url');
  } finally {
    ciphertext?.fill(0);
    packed?.fill(0);
  }
}

/** Opens the service-sealed cache update without exposing it outside the helper. Caller owns and must zero the result. */
export function openVaultCacheEnvelope(sealedMaster: string, sessionKey: Buffer): Buffer {
  const packed = Buffer.from(sealedMaster, 'base64url');
  let plaintext: Buffer | undefined;
  try {
    if (packed.byteLength < 29) throw new Error('Vault cache update is truncated');
    const decipher = createDecipheriv('aes-256-gcm', sessionKey, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
    const decoded = JSON.parse(plaintext.toString('utf8')) as { masterKey?: string };
    if (typeof decoded.masterKey !== 'string') throw new Error('Vault cache update did not contain a master key');
    const masterKey = Buffer.from(decoded.masterKey, 'base64url');
    if (masterKey.byteLength !== 32) {
      masterKey.fill(0);
      throw new Error('Vault cache update master key has an invalid length');
    }
    return masterKey;
  } finally {
    packed.fill(0);
    plaintext?.fill(0);
  }
}
