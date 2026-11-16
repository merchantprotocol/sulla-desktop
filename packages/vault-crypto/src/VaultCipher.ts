// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SodiumRuntime } from './SodiumRuntime.js';
import {
  VAULT_CRYPTO_VERSION,
  type Base64,
  type EncryptedEnvelope,
  type PublicKeyEnvelope,
  type X25519RecipientKeyPair,
} from './types.js';

/**
 * The vault's symmetric and public-key primitives: XChaCha20-Poly1305 envelopes bound to a context
 * string, and X25519 sealed boxes. Byte layout and error messages are part of the stored format.
 */
export class VaultCipher {
  static readonly KEY_BYTES = 32;
  private static readonly NONCE_BYTES = 24;

  private readonly encoder = new TextEncoder();

  constructor(private readonly runtime: SodiumRuntime) {}

  /** Throws `<label> must be 32 bytes` for any other length. */
  assertKey(key: Uint8Array, label: string): void {
    if (key.byteLength !== VaultCipher.KEY_BYTES) {
      throw new Error(`${ label } must be ${ VaultCipher.KEY_BYTES } bytes`);
    }
  }

  async generateKey(): Promise<Uint8Array> {
    const sodium = await this.runtime.ready();
    return sodium.randombytes_buf(VaultCipher.KEY_BYTES);
  }

  async encryptWithKey(plaintext: Uint8Array, key: Uint8Array, context: string): Promise<EncryptedEnvelope> {
    const sodium = await this.runtime.ready();
    this.assertKey(key, 'Encryption key');
    const nonce = sodium.randombytes_buf(VaultCipher.NONCE_BYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      this.encoder.encode(context),
      null,
      nonce,
      key,
    );
    return {
      version:    VAULT_CRYPTO_VERSION,
      algorithm:  'xchacha20-poly1305',
      nonce:      this.runtime.encode(nonce),
      ciphertext: this.runtime.encode(ciphertext),
    };
  }

  async decryptWithKey(envelope: EncryptedEnvelope, key: Uint8Array, context: string): Promise<Uint8Array> {
    const sodium = await this.runtime.ready();
    this.assertKey(key, 'Encryption key');
    if (envelope.version !== VAULT_CRYPTO_VERSION || envelope.algorithm !== 'xchacha20-poly1305') {
      throw new Error('Unsupported encrypted envelope');
    }
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      this.runtime.decode(envelope.ciphertext),
      this.encoder.encode(context),
      this.runtime.decode(envelope.nonce),
      key,
    );
  }

  /** A fresh X25519 key pair; the public key is base64url. */
  async generateKeyPair(): Promise<X25519RecipientKeyPair> {
    const sodium = await this.runtime.ready();
    const pair = sodium.crypto_box_keypair();
    return { publicKey: this.runtime.encode(pair.publicKey), privateKey: pair.privateKey };
  }

  async wrapKeyToPublicKey(key: Uint8Array, recipientPublicKey: Base64): Promise<PublicKeyEnvelope> {
    const sodium = await this.runtime.ready();
    this.assertKey(key, 'Wrapped key');
    const ciphertext = sodium.crypto_box_seal(key, this.runtime.decode(recipientPublicKey));
    return { version: VAULT_CRYPTO_VERSION, algorithm: 'x25519-sealed-box', ciphertext: this.runtime.encode(ciphertext) };
  }

  async unwrapKeyFromPublicKey(
    envelope: PublicKeyEnvelope,
    recipientPublicKey: Base64,
    recipientPrivateKey: Uint8Array,
  ): Promise<Uint8Array> {
    const sodium = await this.runtime.ready();
    if (envelope.version !== VAULT_CRYPTO_VERSION || envelope.algorithm !== 'x25519-sealed-box') {
      throw new Error('Unsupported public-key envelope');
    }
    return sodium.crypto_box_seal_open(
      this.runtime.decode(envelope.ciphertext),
      this.runtime.decode(recipientPublicKey),
      recipientPrivateKey,
    );
  }
}
