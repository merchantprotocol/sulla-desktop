// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { NobleCryptoPrimitives, type CryptoPrimitives, type RandomSource } from '@sulla/domain';

/** libsodium implementation of the domain package's crypto boundary. */
export class SodiumCryptoPrimitives implements CryptoPrimitives, RandomSource {
  constructor(private readonly sodium: any, private readonly noble: CryptoPrimitives) {}
  argon2id13(password: Uint8Array, salt: Uint8Array, memoryBytes: number, ops: number): Uint8Array {
    return this.sodium.crypto_pwhash(32, password, salt, ops, memoryBytes, this.sodium.crypto_pwhash_ALG_ARGON2ID13);
  }
  blake2b(message: Uint8Array, length: number, key?: Uint8Array): Uint8Array { return this.sodium.crypto_generichash(length, message, key); }
  blake2bKdf(key: Uint8Array, subkeyId: number, context: string, length = 32): Uint8Array { return this.sodium.crypto_kdf_derive_from_key(length, subkeyId, context, key); }
  sha256(message: Uint8Array): Uint8Array { return this.sodium.crypto_hash_sha256(message); }
  xchachaSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad = new Uint8Array()): Uint8Array { return this.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key); }
  xchachaOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad = new Uint8Array()): Uint8Array { return this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key); }
  aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array { return this.noble.aesGcmSeal(key, nonce, plaintext, aad); }
  aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Uint8Array { return this.noble.aesGcmOpen(key, nonce, ciphertext, aad); }
  hkdfSha256(key: Uint8Array, salt: Uint8Array, info: Uint8Array, length?: number): Uint8Array { return this.noble.hkdfSha256(key, salt, info, length); }
  hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array { return this.noble.hmacSha256(key, message); }
  x25519PublicKey(privateKey: Uint8Array): Uint8Array { return this.noble.x25519PublicKey(privateKey); }
  x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array { return this.noble.x25519SharedSecret(privateKey, publicKey); }
  p256PublicKey(privateKey: Uint8Array): Uint8Array { return this.noble.p256PublicKey(privateKey); }
  p256SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array { return this.noble.p256SharedSecret(privateKey, publicKey); }
  ed25519PublicKey(seed: Uint8Array): Uint8Array { return this.noble.ed25519PublicKey(seed); }
  ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array { return this.noble.ed25519Sign(seed, message); }
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean { return this.noble.ed25519Verify(publicKey, message, signature); }
  bytes(length: number): Uint8Array { return this.sodium.randombytes_buf(length); }
}
