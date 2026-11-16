// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { webcrypto } from 'node:crypto';

/**
 * Wraps the 32-byte memory-sync key under a user's 32-byte vault key with AES-256-GCM.
 * Blob: base64(nonce(12) || ciphertext(32) || tag(16)); AAD `SVmemkey001|<userId>`.
 */
export class MemorySyncKeyWrap {
  private static readonly AAD_PREFIX = 'SVmemkey001';
  private readonly enc = new TextEncoder();

  constructor(private readonly crypto: webcrypto.Crypto = webcrypto) {}

  async wrap(userKey: Uint8Array, userId: string, memoryKey: Uint8Array): Promise<string> {
    if (userKey.byteLength !== 32 || memoryKey.byteLength !== 32 || !userId) throw new Error('invalid_request');
    const aes = await this.crypto.subtle.importKey('raw', userKey, { name: 'AES-GCM' }, false, ['encrypt']), nonce = this.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: this.aad(userId), tagLength: 128 }, aes, memoryKey));
    return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]).toString('base64');
  }

  async unwrap(userKey: Uint8Array, userId: string, wrappedKey: string): Promise<Uint8Array> {
    if (userKey.byteLength !== 32 || !userId || typeof wrappedKey !== 'string' || wrappedKey.length > 4096) throw new Error('invalid_request');
    const packed = Buffer.from(wrappedKey, 'base64'); if (packed.byteLength !== 60) throw new Error('invalid_request');
    const aes = await this.crypto.subtle.importKey('raw', userKey, { name: 'AES-GCM' }, false, ['decrypt']);
    try { return new Uint8Array(await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.subarray(0, 12), additionalData: this.aad(userId), tagLength: 128 }, aes, packed.subarray(12))); } catch { throw new Error('memory_key_unwrap_failed'); }
  }

  private aad(userId: string) {
    return this.enc.encode(`${ MemorySyncKeyWrap.AAD_PREFIX }|${ userId }`);
  }
}

/** @deprecated use MemorySyncKeyWrap.wrap — E9 alias, removed in final cleanup */
export function wrapMemorySyncKey(userKey: Uint8Array, userId: string, memoryKey: Uint8Array): Promise<string> {
  return new MemorySyncKeyWrap().wrap(userKey, userId, memoryKey);
}

/** @deprecated use MemorySyncKeyWrap.unwrap — E9 alias, removed in final cleanup */
export function unwrapMemorySyncKey(userKey: Uint8Array, userId: string, wrappedKey: string): Promise<Uint8Array> {
  return new MemorySyncKeyWrap().unwrap(userKey, userId, wrappedKey);
}
