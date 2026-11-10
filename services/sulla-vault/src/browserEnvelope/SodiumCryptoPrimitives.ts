// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { CryptoPrimitives, RandomSource } from '@sulla/domain';

/** libsodium implementation of the domain package's crypto boundary. */
export class SodiumCryptoPrimitives implements CryptoPrimitives, RandomSource {
  constructor(private readonly sodium: any) {}
  blake2b(message: Uint8Array, length: number, key?: Uint8Array): Uint8Array { return this.sodium.crypto_generichash(length, message, key); }
  blake2bKdf(key: Uint8Array, subkeyId: number, context: string, length = 32): Uint8Array { return this.sodium.crypto_kdf_derive_from_key(length, subkeyId, context, key); }
  sha256(message: Uint8Array): Uint8Array { return this.sodium.crypto_hash_sha256(message); }
  xchachaSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad = new Uint8Array()): Uint8Array { return this.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key); }
  xchachaOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad = new Uint8Array()): Uint8Array { return this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key); }
  bytes(length: number): Uint8Array { return this.sodium.randombytes_buf(length); }
}
