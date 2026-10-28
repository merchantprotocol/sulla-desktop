// SPDX-License-Identifier: GPL-2.0-or-later
import { createHmac, randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import sodium from 'libsodium-wrappers-sumo';
const ZSTD_BLOCK_BYTES = 128 * 1024;
const AEAD_TAG_BYTES = 16;
const XCHACHA_NONCE_BYTES = 24;
const EMPTY_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ version: 1, algorithm: 'xchacha20-poly1305', nonce: '', ciphertext: '' }));
const b64 = (value) => Buffer.from(value).toString('base64url');
const bytes = (value) => new Uint8Array(Buffer.from(value, 'base64url'));
const b64Length = (length) => Math.ceil(length * 4 / 3);
/** ZSTD_COMPRESSBOUND plus the fixed AEAD and serialized envelope expansion. */
export function maxEncryptedChunkBytes(plainBytes) {
    if (!Number.isSafeInteger(plainBytes) || plainBytes < 0)
        throw new Error('Invalid plaintext bound');
    const compressed = plainBytes + Math.floor(plainBytes / 256) + (plainBytes < ZSTD_BLOCK_BYTES ? Math.floor((ZSTD_BLOCK_BYTES - plainBytes) / 2048) : 0);
    return EMPTY_ENVELOPE_BYTES + b64Length(XCHACHA_NONCE_BYTES) + b64Length(compressed + AEAD_TAG_BYTES);
}
export async function encrypt(value, key, context) {
    await sodium.ready;
    const nonce = randomBytes(24);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(value, Buffer.from(context), null, nonce, key);
    return { version: 1, algorithm: 'xchacha20-poly1305', nonce: b64(nonce), ciphertext: b64(ciphertext) };
}
export async function decrypt(value, key, context) {
    await sodium.ready;
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes(value.ciphertext), Buffer.from(context), bytes(value.nonce), key);
}
export function chunkId(value, key) { return createHmac('sha256', key).update(value).digest('hex'); }
export async function encryptChunk(value, key, id) {
    const compressed = zlib.zstdCompressSync(Buffer.from(value), { level: 3 });
    return Buffer.from(JSON.stringify(await encrypt(compressed, key, `sulla:file-chunk:v1:${id}`)));
}
export async function decryptChunk(value, key, id, expectedPlainBytes) {
    const compressed = await decrypt(JSON.parse(Buffer.from(value).toString('utf8')), key, `sulla:file-chunk:v1:${id}`);
    const options = expectedPlainBytes === undefined ? undefined : { maxOutputLength: Math.max(1, expectedPlainBytes) };
    const plain = zlib.zstdDecompressSync(Buffer.from(compressed), options);
    if (expectedPlainBytes !== undefined && plain.length !== expectedPlainBytes)
        throw new Error(`Decrypted chunk size mismatch for ${id}`);
    return plain;
}
export async function decryptAndVerifyChunk(value, dataKey, dedupKey, id, expectedPlainBytes) {
    const plain = await decryptChunk(value, dataKey, id, expectedPlainBytes);
    if (chunkId(plain, dedupKey) !== id)
        throw new Error(`Decrypted chunk identity mismatch for ${id}`);
    return plain;
}
