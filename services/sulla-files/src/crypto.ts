import { createHmac, randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';

import sodium from 'libsodium-wrappers-sumo';

export interface Envelope { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string }
const ZSTD_BLOCK_BYTES = 128 * 1024;
const AEAD_TAG_BYTES = 16;
const XCHACHA_NONCE_BYTES = 24;
const EMPTY_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ version: 1, algorithm: 'xchacha20-poly1305', nonce: '', ciphertext: '' }));
const b64 = (value:Uint8Array) => Buffer.from(value).toString('base64url');
const bytes = (value:string) => new Uint8Array(Buffer.from(value, 'base64url'));
const b64Length = (length:number) => Math.ceil(length * 4 / 3);

/** ZSTD_COMPRESSBOUND plus the fixed AEAD and serialized envelope expansion. */
export function maxEncryptedChunkBytes(plainBytes:number):number {
  if (!Number.isSafeInteger(plainBytes) || plainBytes < 0) throw new Error('Invalid plaintext bound');
  const compressed = plainBytes + Math.floor(plainBytes / 256) + (plainBytes < ZSTD_BLOCK_BYTES ? Math.floor((ZSTD_BLOCK_BYTES - plainBytes) / 2048) : 0);

  return EMPTY_ENVELOPE_BYTES + b64Length(XCHACHA_NONCE_BYTES) + b64Length(compressed + AEAD_TAG_BYTES);
}
export async function encrypt(value:Uint8Array, key:Uint8Array, context:string):Promise<Envelope> {
  await sodium.ready;
  const nonce = randomBytes(24);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(value, Buffer.from(context), null, nonce, key);

  return { version: 1, algorithm: 'xchacha20-poly1305', nonce: b64(nonce), ciphertext: b64(ciphertext) };
}
export async function decrypt(value:Envelope, key:Uint8Array, context:string):Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes(value.ciphertext), Buffer.from(context), bytes(value.nonce), key);
}
export function chunkId(value:Uint8Array, key:Uint8Array):string { return createHmac('sha256', key).update(value).digest('hex') }
export async function encryptChunk(value:Uint8Array, key:Uint8Array, id:string):Promise<Buffer> {
  const compressed = (zlib as any).zstdCompressSync(Buffer.from(value), { level: 3 }) as Buffer;
  return Buffer.from(JSON.stringify(await encrypt(compressed, key, `sulla:file-chunk:v1:${ id }`)));
}
export async function decryptChunk(value:Uint8Array, key:Uint8Array, id:string, expectedPlainBytes?:number):Promise<Buffer> {
  const compressed = await decrypt(JSON.parse(Buffer.from(value).toString('utf8')), key, `sulla:file-chunk:v1:${ id }`);
  const options = expectedPlainBytes === undefined ? undefined : { maxOutputLength: Math.max(1, expectedPlainBytes) };
  const plain = (zlib as any).zstdDecompressSync(Buffer.from(compressed), options) as Buffer;
  if (expectedPlainBytes !== undefined && plain.length !== expectedPlainBytes) throw new Error(`Decrypted chunk size mismatch for ${ id }`);
  return plain;
}

export async function decryptAndVerifyChunk(value:Uint8Array, dataKey:Uint8Array, dedupKey:Uint8Array, id:string, expectedPlainBytes:number):Promise<Buffer> {
  const plain = await decryptChunk(value, dataKey, id, expectedPlainBytes);
  if (chunkId(plain, dedupKey) !== id) throw new Error(`Decrypted chunk identity mismatch for ${ id }`);
  return plain;
}
