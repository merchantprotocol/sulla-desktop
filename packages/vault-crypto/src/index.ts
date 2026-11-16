// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Public surface of @sulla/vault-crypto. The logic lives in classes (VaultCrypto and its parts);
// the named functions below are the stable legacy API and only delegate to VaultCrypto.shared().

import { VaultCrypto } from './VaultCrypto.js';
import type {
  Argon2idParameters,
  Base64,
  DerivedMasterKey,
  EncryptedEnvelope,
  EncryptedItem,
  ItemContext,
  PublicKeyEnvelope,
  WrappedKeyPair,
} from './types.js';

export {
  DEFAULT_ARGON2ID,
  type Argon2idParameters,
  type Base64,
  type DerivedMasterKey,
  type EncryptedEnvelope,
  type EncryptedItem,
  type ItemContext,
  type PublicKeyEnvelope,
  type WrappedKeyPair,
} from './types.js';
export { SodiumRuntime, type SodiumApi } from './SodiumRuntime.js';
export { VaultCipher } from './VaultCipher.js';
export { VaultKeyDerivation } from './VaultKeyDerivation.js';
export { VaultKeyWrapper } from './VaultKeyWrapper.js';
export { VaultItemEncryptor } from './VaultItemEncryptor.js';
export { FilesKeyBundleCodec } from './FilesKeyBundleCodec.js';
export { VaultCrypto } from './VaultCrypto.js';

export function itemAssociatedData(purpose: 'key' | 'ciphertext', context: ItemContext): string {
  return VaultCrypto.shared().items.associatedData(purpose, context);
}

export function deriveMasterKey(masterPassword: string, salt?: Base64, parameters?: Argon2idParameters): Promise<DerivedMasterKey> {
  return VaultCrypto.shared().keys.deriveMasterKey(masterPassword, salt, parameters);
}

export function deriveAccountAuthHash(masterKey: Uint8Array): Promise<Base64> {
  return VaultCrypto.shared().keys.deriveAccountAuthHash(masterKey);
}

export function deriveLoginHash(masterKey: Uint8Array): Promise<Base64> {
  return VaultCrypto.shared().keys.deriveLoginHash(masterKey);
}

export function deriveOrgJoinHash(joinPassword: string, orgId: string): Promise<Base64> {
  return VaultCrypto.shared().keys.deriveOrgJoinHash(joinPassword, orgId);
}

export function publicKeyFingerprint(publicKey: Base64): Promise<string> {
  return VaultCrypto.shared().keys.publicKeyFingerprint(publicKey);
}

export function generateKey(): Promise<Uint8Array> {
  return VaultCrypto.shared().cipher.generateKey();
}

export function encryptWithKey(plaintext: Uint8Array, key: Uint8Array, context: string): Promise<EncryptedEnvelope> {
  return VaultCrypto.shared().cipher.encryptWithKey(plaintext, key, context);
}

export function decryptWithKey(envelope: EncryptedEnvelope, key: Uint8Array, context: string): Promise<Uint8Array> {
  return VaultCrypto.shared().cipher.decryptWithKey(envelope, key, context);
}

export function createUserKey(masterKey: Uint8Array): Promise<{ userKey: Uint8Array; encryptedUserKey: EncryptedEnvelope }> {
  return VaultCrypto.shared().keyWrapper.createUserKey(masterKey);
}

export function unwrapUserKey(encryptedUserKey: EncryptedEnvelope, masterKey: Uint8Array): Promise<Uint8Array> {
  return VaultCrypto.shared().keyWrapper.unwrapUserKey(encryptedUserKey, masterKey);
}

export function encryptItem(
  plaintext: Uint8Array | string,
  ownerKey: Uint8Array,
  context: ItemContext,
  agentPublicKey?: Base64,
): Promise<EncryptedItem> {
  return VaultCrypto.shared().items.encrypt(plaintext, ownerKey, context, agentPublicKey);
}

export function decryptItem(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<Uint8Array> {
  return VaultCrypto.shared().items.decrypt(item, ownerKey, context);
}

export function decryptItemText(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<string> {
  return VaultCrypto.shared().items.decryptText(item, ownerKey, context);
}

export function createUserKeyPair(userKey: Uint8Array): Promise<WrappedKeyPair & { privateKey: Uint8Array }> {
  return VaultCrypto.shared().keyWrapper.createUserKeyPair(userKey);
}

export function unwrapUserPrivateKey(encryptedPrivateKey: EncryptedEnvelope, userKey: Uint8Array): Promise<Uint8Array> {
  return VaultCrypto.shared().keyWrapper.unwrapUserPrivateKey(encryptedPrivateKey, userKey);
}

export function wrapKeyToPublicKey(key: Uint8Array, recipientPublicKey: Base64): Promise<PublicKeyEnvelope> {
  return VaultCrypto.shared().cipher.wrapKeyToPublicKey(key, recipientPublicKey);
}

export function unwrapKeyFromPublicKey(
  envelope: PublicKeyEnvelope,
  recipientPublicKey: Base64,
  recipientPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  return VaultCrypto.shared().cipher.unwrapKeyFromPublicKey(envelope, recipientPublicKey, recipientPrivateKey);
}

export const wrapOrgKeyForMember = wrapKeyToPublicKey;
export const unwrapOrgKeyForMember = unwrapKeyFromPublicKey;

export function wrapCollectionKey(collectionKey: Uint8Array, orgKey: Uint8Array): Promise<EncryptedEnvelope> {
  return VaultCrypto.shared().keyWrapper.wrapCollectionKey(collectionKey, orgKey);
}

export function unwrapCollectionKey(encryptedCollectionKey: EncryptedEnvelope, orgKey: Uint8Array): Promise<Uint8Array> {
  return VaultCrypto.shared().keyWrapper.unwrapCollectionKey(encryptedCollectionKey, orgKey);
}

export const wrapItemKeyForAgent = wrapKeyToPublicKey;
export const unwrapItemKeyForAgent = unwrapKeyFromPublicKey;
export * from './itemSchema.js';
export * from './customFields.js';
export * from './filesKeyBundle.js';
export { FilesTransportEnvelopeService, type FilesTransportEnvelope } from './filesTransportEnvelope.js';
