import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface EncryptedValue {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

export function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function equalSecret(actual: string | undefined, expected: Buffer | undefined): boolean {
  if (!actual || !expected) return false;
  const value = Buffer.from(actual);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

export function encrypt(key: Buffer, value: string, context: string): EncryptedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

export function decrypt(key: Buffer, value: EncryptedValue, context: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, value.nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
}

export function base64url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}