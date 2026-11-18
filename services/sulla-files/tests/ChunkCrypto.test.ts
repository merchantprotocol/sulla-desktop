// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterization of the chunk/envelope byte format. Every stored chunk and every
// Vault-wrapped key depends on it, so ChunkCrypto must produce byte-identical output
// to the pre-class implementation (reproduced verbatim below as the reference).
import { createHmac } from 'node:crypto';
import * as zlib from 'node:zlib';
import sodium from 'libsodium-wrappers-sumo';
import { describe, expect, it } from 'vitest';
import { ChunkCrypto, chunkId, decryptAndVerifyChunk, encryptChunk, maxEncryptedChunkBytes } from '../src/crypto.js';

const fixedNonce = (length:number) => new Uint8Array(length).map((_, index) => (index * 7 + 3) & 0xff);
const dataKey = new Uint8Array(32).fill(8);
const dedupKey = new Uint8Array(32).fill(9);

/** The pre-class implementation (crypto.ts at 7b755a8f2), with its random nonce replaced by `fixedNonce`. */
class ReferenceImplementation {
  async encrypt(value:Uint8Array, key:Uint8Array, context:string) {
    await sodium.ready;
    const nonce = fixedNonce(24);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(value, Buffer.from(context), null, nonce, key);
    return { version: 1, algorithm: 'xchacha20-poly1305', nonce: Buffer.from(nonce).toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url') };
  }
  async encryptChunk(value:Uint8Array, key:Uint8Array, id:string):Promise<Buffer> {
    const compressed = (zlib as any).zstdCompressSync(Buffer.from(value), { level: 3 }) as Buffer;
    return Buffer.from(JSON.stringify(await this.encrypt(compressed, key, `sulla:file-chunk:v1:${ id }`)));
  }
}

describe('ChunkCrypto byte format', () => {
  const pinned = new ChunkCrypto(sodium, fixedNonce);
  const reference = new ReferenceImplementation();

  it('produces a chunk envelope byte-identical to the original implementation', async() => {
    // risk: data loss — a changed envelope makes every previously stored chunk unreadable.
    const plain = Buffer.from('sulla chunk '.repeat(500));
    const id = pinned.chunkId(plain, dedupKey);
    expect(Buffer.compare(await pinned.encryptChunk(plain, dataKey, id), await reference.encryptChunk(plain, dataKey, id))).toBe(0);
    expect(await pinned.encrypt(plain, dataKey, 'sulla:key:v1')).toEqual(await reference.encrypt(plain, dataKey, 'sulla:key:v1'));
  });

  it('derives chunk ids as HMAC-SHA256 of the plaintext under the dedup key', () => {
    // risk: data integrity — chunk ids are the dedup and integrity identity of stored content.
    expect(chunkId(Buffer.from('sulla chunk'), Buffer.alloc(32, 9))).toBe('846ca34073b004c673905c5496c7db09e29eed5c020807cf62431631df124864');
    expect(pinned.chunkId(Buffer.from('x'), dedupKey)).toBe(createHmac('sha256', dedupKey).update(Buffer.from('x')).digest('hex'));
  });

  it('keeps the stored-size bound the read path enforces', () => {
    // risk: availability — a tighter bound rejects valid stored chunks; a looser one allows unbounded reads.
    expect([0, 1, 4096, 131072, 4 * 1024 * 1024].map(size => maxEncryptedChunkBytes(size))).toEqual([212, 212, 5692, 175572, 5614377]);
    expect(() => maxEncryptedChunkBytes(-1)).toThrow('Invalid plaintext bound');
  });

  it('round-trips through the function exports and rejects a chunk stored under another id', async() => {
    // risk: data integrity — a blob swapped between ids must fail verification, never return wrong bytes.
    const plain = Buffer.alloc(4096, 71);
    const id = chunkId(plain, dedupKey);
    const stored = await encryptChunk(plain, dataKey, id);
    expect(stored.byteLength).toBeLessThanOrEqual(maxEncryptedChunkBytes(plain.byteLength));
    expect(await decryptAndVerifyChunk(stored, dataKey, dedupKey, id, plain.byteLength)).toEqual(plain);
    await expect(decryptAndVerifyChunk(stored, dataKey, dedupKey, 'f'.repeat(64), plain.byteLength)).rejects.toThrow();
    await expect(decryptAndVerifyChunk(stored, dataKey, dedupKey, id, plain.byteLength - 1)).rejects.toThrow();
  });

  it('keeps the production decrypt zero-key guard while exposing a plaintext-free diagnosis probe', async() => {
    // risk: data integrity — zeroized cache keys must not silently decrypt as valid production content.
    const zeroKey = new Uint8Array(32);
    await sodium.ready;
    const nonce = fixedNonce(24);
    const envelope = {
      version:1 as const, algorithm:'xchacha20-poly1305' as const,
      nonce:Buffer.from(nonce).toString('base64url'),
      ciphertext:Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(Buffer.from('diagnostic fixture'), Buffer.from('diagnostic AAD'), null, nonce, zeroKey)).toString('base64url'),
    };
    await expect(pinned.decrypt(envelope, zeroKey, 'diagnostic AAD')).rejects.toThrow('All-zero key');
    await expect(pinned.opensWithZeroKeyForDiagnosis(envelope, 'diagnostic AAD')).resolves.toBe(true);
    await expect(pinned.opensWithZeroKeyForDiagnosis(envelope, 'wrong AAD')).resolves.toBe(false);
  });
});
