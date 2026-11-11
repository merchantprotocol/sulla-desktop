// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { NobleCryptoPrimitives, type RandomSource } from '@sulla/domain';

/** The libsodium calls Desktop uses for Cloud account keys, with the shared domain Noble code for the rest. */
export interface AccountSodium {
  crypto_pwhash(length: number, password: Uint8Array, salt: Uint8Array, ops: number, memoryBytes: number, algorithm: number): Uint8Array;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_generichash(length: number, message: Uint8Array, key: Uint8Array | null): Uint8Array;
  randombytes_buf(length: number): Uint8Array;
}

/**
 * Argon2id and BLAKE2b run on the same libsodium Desktop already uses, so a Cloud password derives the
 * identical key it always did (and it is fast: the Noble Argon2 would take seconds at 64 MiB).
 */
export class SodiumAccountPrimitives extends NobleCryptoPrimitives implements RandomSource {
  constructor(private readonly sodium: AccountSodium) {
    super();
  }

  override argon2id13(password: Uint8Array, salt: Uint8Array, memoryBytes: number, ops: number): Uint8Array {
    return this.sodium.crypto_pwhash(32, password, salt, ops, memoryBytes, this.sodium.crypto_pwhash_ALG_ARGON2ID13);
  }

  override blake2b(message: Uint8Array, length: number, key?: Uint8Array): Uint8Array {
    return this.sodium.crypto_generichash(length, message, key ?? null);
  }

  bytes(length: number): Uint8Array {
    return this.sodium.randombytes_buf(length);
  }
}
