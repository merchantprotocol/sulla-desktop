// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SubkeyPurpose } from './envelopeTypes.js';

/** WebCrypto wants ArrayBuffer-backed views; Buffers and subarrays satisfy that at runtime. */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The shared building blocks of Files sync envelope v1: encodings, input checks, HKDF
 * subkeys and WebCrypto key imports. WebCrypto only, so it runs on Node's OpenSSL-backed
 * globalThis.crypto. Output must stay byte-identical to files-sync-v1-kat.json.
 */
export class SyncCryptoPrimitives {
  static readonly uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  static readonly hex64 = /^[0-9a-f]{64}$/;
  readonly enc = new TextEncoder();
  private readonly salt = this.enc.encode('sulla-files-sync-v1');

  constructor(readonly subtle:SubtleCrypto = globalThis.crypto.subtle) {}

  view(value:Uint8Array):Bytes {
    return value as Bytes;
  }

  assertUuid(value:unknown, what:string):void {
    if (typeof value !== 'string' || !SyncCryptoPrimitives.uuid.test(value)) throw new Error(`bad ${ what }`);
  }

  assertKeyVersion(keyVersion:unknown):void {
    if (!Number.isInteger(keyVersion) || (keyVersion as number) < 1 || (keyVersion as number) > 0xffffffff) throw new Error('bad keyVersion');
  }

  b64u(bytes:Uint8Array):string {
    return Buffer.from(bytes).toString('base64url');
  }

  unb64u(value:string):Bytes {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('bad base64url');
    return new Uint8Array(Buffer.from(value, 'base64url'));
  }

  hex(bytes:ArrayBuffer | Uint8Array):string {
    return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('hex');
  }

  async sha256Hex(bytes:Uint8Array):Promise<string> {
    return this.hex(await this.subtle.digest('SHA-256', this.view(bytes)));
  }

  async hkdf(ikm:Uint8Array, salt:Uint8Array, info:string):Promise<Uint8Array> {
    if (!(ikm instanceof Uint8Array) || ikm.byteLength !== 32) throw new Error('bad key');
    const base = await this.subtle.importKey('raw', this.view(ikm), 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await this.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: this.view(salt), info: this.enc.encode(info) }, base, 256));
  }

  /** Per-object subkey. purpose ∈ chunk-id | chunk | manifest | head | info. */
  subkey(root:Uint8Array, purpose:SubkeyPurpose, collectionId:string, keyVersion:number, objectId = ''):Promise<Uint8Array> {
    this.assertUuid(collectionId, 'collectionId');
    this.assertKeyVersion(keyVersion);
    return this.hkdf(root, this.salt, `${ purpose }|${ collectionId }|${ keyVersion }|${ objectId }`);
  }

  aesKey(raw:Uint8Array, use:'encrypt' | 'decrypt'):Promise<CryptoKey> {
    return this.subtle.importKey('raw', this.view(raw), { name: 'AES-GCM' }, false, [use]);
  }

  hmacKey(raw:Uint8Array):Promise<CryptoKey> {
    return this.subtle.importKey('raw', this.view(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  /** A fresh random 96-bit nonce, or the fixed one (known-answer tests only). */
  nonce12(fixed?:Uint8Array):Bytes {
    return fixed ? this.view(fixed) : globalThis.crypto.getRandomValues(new Uint8Array(12));
  }
}
