import { createHmac, randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';

import sodium from 'libsodium-wrappers-sumo';

export interface Envelope { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string }
const b64 = (value:Uint8Array) => Buffer.from(value).toString('base64url');
const bytes = (value:string) => new Uint8Array(Buffer.from(value, 'base64url'));
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
export async function decryptChunk(value:Uint8Array, key:Uint8Array, id:string):Promise<Buffer> {
  const compressed = await decrypt(JSON.parse(Buffer.from(value).toString('utf8')), key, `sulla:file-chunk:v1:${ id }`);
  return (zlib as any).zstdDecompressSync(Buffer.from(compressed));
}
