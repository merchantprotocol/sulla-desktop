// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Shared shapes of the vault crypto envelopes. Changing any of these changes stored data.

export const VAULT_CRYPTO_VERSION = 1 as const;

export type Base64 = string;

export interface Argon2idParameters {
  memoryBytes: number;
  operations:  number;
}

export const DEFAULT_ARGON2ID: Argon2idParameters = {
  memoryBytes: 64 * 1024 * 1024,
  operations:  3,
};

export interface DerivedMasterKey {
  key:        Uint8Array;
  salt:       Base64;
  parameters: Argon2idParameters;
}

export interface EncryptedEnvelope {
  version:    typeof VAULT_CRYPTO_VERSION;
  algorithm:  'xchacha20-poly1305';
  nonce:      Base64;
  ciphertext: Base64;
}

export interface WrappedKeyPair {
  publicKey:           Base64;
  encryptedPrivateKey: EncryptedEnvelope;
}

export interface EncryptedItem {
  version:              typeof VAULT_CRYPTO_VERSION;
  encryptedItemKey:     EncryptedEnvelope;
  ciphertext:           EncryptedEnvelope;
  agentWrappedItemKey?: PublicKeyEnvelope;
}

export interface ItemContext {
  itemId:  string;
  ownerId: string;
}

export interface PublicKeyEnvelope {
  version:    typeof VAULT_CRYPTO_VERSION;
  algorithm:  'x25519-sealed-box';
  ciphertext: Base64;
}

export interface X25519RecipientKeyPair {
  publicKey:  Base64;
  privateKey: Uint8Array;
}
