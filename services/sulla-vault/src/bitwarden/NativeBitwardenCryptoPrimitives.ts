// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as nodeCrypto from 'node:crypto';

import type { BitwardenCryptoPrimitives } from '@sulla/domain';

/** Node's native Argon2 (`node:crypto.argon2Sync`, Node >= 24.7; OpenSSL). Absent on older runtimes. */
export type NativeArgon2 = (algorithm: 'argon2id', parameters: { message: Uint8Array; nonce: Uint8Array; parallelism: number; tagLength: number; memory: number; passes: number }) => Uint8Array;

/**
 * Bitwarden export crypto on native code (node:crypto / OpenSSL) instead of the
 * domain's pure-JS noble default, which is several times slower and holds the
 * vault event loop for the whole key derivation.
 *
 * libsodium (what the vault seals items with) can't be used for the KDF:
 * `crypto_pwhash` only accepts a 16-byte salt and one lane, and Bitwarden's
 * Argon2id uses a 32-byte salt (SHA-256 of the export salt) and, by default,
 * parallelism 4.
 *
 * Argon2id runs on Node's native Argon2 when the runtime has it (the vault
 * image is node:24), else on `fallback` (the domain's noble primitives).
 * PBKDF2-SHA256, HMAC-SHA256, SHA-256 and AES-256-CBC are node:crypto, as the
 * pre-domain Desktop importer used.
 */
export class NativeBitwardenCryptoPrimitives implements BitwardenCryptoPrimitives {
  constructor(
    private readonly fallback: BitwardenCryptoPrimitives,
    private readonly nativeArgon2: NativeArgon2 | undefined = (nodeCrypto as unknown as { argon2Sync?: NativeArgon2 }).argon2Sync,
  ) {}

  /** True when Argon2id runs natively rather than on the pure-JS fallback. */
  get nativeArgon2Available(): boolean {
    return typeof this.nativeArgon2 === 'function';
  }

  argon2id13(password: Uint8Array, salt: Uint8Array, iterations: number, memoryKiB: number, parallelism: number): Uint8Array {
    if (!this.nativeArgon2) return this.fallback.argon2id13(password, salt, iterations, memoryKiB, parallelism);
    return new Uint8Array(this.nativeArgon2('argon2id', { message: password, nonce: salt, parallelism, tagLength: 32, memory: memoryKiB, passes: iterations }));
  }

  pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number): Uint8Array {
    return new Uint8Array(nodeCrypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256'));
  }

  sha256(value: Uint8Array): Uint8Array {
    return new Uint8Array(nodeCrypto.createHash('sha256').update(value).digest());
  }

  hmacSha256(key: Uint8Array, value: Uint8Array): Uint8Array {
    return new Uint8Array(nodeCrypto.createHmac('sha256', key).update(value).digest());
  }

  aes256CbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
}
