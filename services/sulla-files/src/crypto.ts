// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHmac, randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';

import sodium from 'libsodium-wrappers-sumo';

export interface Envelope { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string }

/** The libsodium surface ChunkCrypto uses; injected so tests can pin it. */
export interface SodiumAead {
  ready:Promise<unknown>;
  crypto_aead_xchacha20poly1305_ietf_encrypt(message:Uint8Array, additionalData:Uint8Array | null, secretNonce:null, publicNonce:Uint8Array, key:Uint8Array):Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(secretNonce:null, ciphertext:Uint8Array, additionalData:Uint8Array | null, publicNonce:Uint8Array, key:Uint8Array):Uint8Array;
}

export type NonceSource = (length:number) => Uint8Array;

/**
 * Chunk and envelope cryptography for Files: XChaCha20-Poly1305 envelopes, zstd-compressed
 * chunk envelopes, keyed chunk ids, and the stored-size bound the read path enforces.
 * Every stored chunk depends on this exact byte format; never change it.
 */
export class ChunkCrypto {
  private static readonly ZSTD_BLOCK_BYTES = 128 * 1024;
  private static readonly AEAD_TAG_BYTES = 16;
  private static readonly XCHACHA_NONCE_BYTES = 24;
  private static readonly EMPTY_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ version: 1, algorithm: 'xchacha20-poly1305', nonce: '', ciphertext: '' }));

  constructor(private readonly aead:SodiumAead = sodium, private readonly nonces:NonceSource = randomBytes) {}

  /** ZSTD_COMPRESSBOUND plus the fixed AEAD and serialized envelope expansion. */
  maxEncryptedChunkBytes(plainBytes:number):number {
    if (!Number.isSafeInteger(plainBytes) || plainBytes < 0) throw new Error('Invalid plaintext bound');
    const block = ChunkCrypto.ZSTD_BLOCK_BYTES;
    const compressed = plainBytes + Math.floor(plainBytes / 256) + (plainBytes < block ? Math.floor((block - plainBytes) / 2048) : 0);

    return ChunkCrypto.EMPTY_ENVELOPE_BYTES + this.b64Length(ChunkCrypto.XCHACHA_NONCE_BYTES) + this.b64Length(compressed + ChunkCrypto.AEAD_TAG_BYTES);
  }

  async encrypt(value:Uint8Array, key:Uint8Array, context:string):Promise<Envelope> {
    await this.aead.ready;
    const nonce = this.nonces(24);
    const ciphertext = this.aead.crypto_aead_xchacha20poly1305_ietf_encrypt(value, Buffer.from(context), null, nonce, key);

    return { version: 1, algorithm: 'xchacha20-poly1305', nonce: this.b64(nonce), ciphertext: this.b64(ciphertext) };
  }

  async decrypt(value:Envelope, key:Uint8Array, context:string):Promise<Uint8Array> {
    await this.aead.ready;
    return this.aead.crypto_aead_xchacha20poly1305_ietf_decrypt(null, this.bytes(value.ciphertext), Buffer.from(context), this.bytes(value.nonce), key);
  }

  chunkId(value:Uint8Array, key:Uint8Array):string { return createHmac('sha256', key).update(value).digest('hex') }

  async encryptChunk(value:Uint8Array, key:Uint8Array, id:string):Promise<Buffer> {
    const compressed = (zlib as any).zstdCompressSync(Buffer.from(value), { level: 3 }) as Buffer;
    return Buffer.from(JSON.stringify(await this.encrypt(compressed, key, `sulla:file-chunk:v1:${ id }`)));
  }

  async decryptChunk(value:Uint8Array, key:Uint8Array, id:string, expectedPlainBytes?:number):Promise<Buffer> {
    const compressed = await this.decrypt(JSON.parse(Buffer.from(value).toString('utf8')), key, `sulla:file-chunk:v1:${ id }`);
    const options = expectedPlainBytes === undefined ? undefined : { maxOutputLength: Math.max(1, expectedPlainBytes) };
    const plain = (zlib as any).zstdDecompressSync(Buffer.from(compressed), options) as Buffer;
    if (expectedPlainBytes !== undefined && plain.length !== expectedPlainBytes) throw new Error(`Decrypted chunk size mismatch for ${ id }`);
    return plain;
  }

  async decryptAndVerifyChunk(value:Uint8Array, dataKey:Uint8Array, dedupKey:Uint8Array, id:string, expectedPlainBytes:number):Promise<Buffer> {
    const plain = await this.decryptChunk(value, dataKey, id, expectedPlainBytes);
    if (this.chunkId(plain, dedupKey) !== id) throw new Error(`Decrypted chunk identity mismatch for ${ id }`);
    return plain;
  }

  private b64(value:Uint8Array):string { return Buffer.from(value).toString('base64url') }
  private bytes(value:string):Uint8Array { return new Uint8Array(Buffer.from(value, 'base64url')) }
  private b64Length(length:number):number { return Math.ceil(length * 4 / 3) }
}

/** Shared stateless instance behind the function exports below. */
export const defaultChunkCrypto = new ChunkCrypto();

// Function exports kept for callers outside this module (keyring, localManager, app, cloudSync,
// legacyImport, preview, residency, shares, indexSource). They delegate to `defaultChunkCrypto`.
export function maxEncryptedChunkBytes(plainBytes:number):number { return defaultChunkCrypto.maxEncryptedChunkBytes(plainBytes) }
export function encrypt(value:Uint8Array, key:Uint8Array, context:string):Promise<Envelope> { return defaultChunkCrypto.encrypt(value, key, context) }
export function decrypt(value:Envelope, key:Uint8Array, context:string):Promise<Uint8Array> { return defaultChunkCrypto.decrypt(value, key, context) }
export function chunkId(value:Uint8Array, key:Uint8Array):string { return defaultChunkCrypto.chunkId(value, key) }
export function encryptChunk(value:Uint8Array, key:Uint8Array, id:string):Promise<Buffer> { return defaultChunkCrypto.encryptChunk(value, key, id) }
export function decryptChunk(value:Uint8Array, key:Uint8Array, id:string, expectedPlainBytes?:number):Promise<Buffer> { return defaultChunkCrypto.decryptChunk(value, key, id, expectedPlainBytes) }
export function decryptAndVerifyChunk(value:Uint8Array, dataKey:Uint8Array, dedupKey:Uint8Array, id:string, expectedPlainBytes:number):Promise<Buffer> {
  return defaultChunkCrypto.decryptAndVerifyChunk(value, dataKey, dedupKey, id, expectedPlainBytes);
}
