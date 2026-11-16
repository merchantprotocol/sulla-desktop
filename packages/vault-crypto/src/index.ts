// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import sodium from 'libsodium-wrappers-sumo';

const VERSION = 1 as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const CLOUD_AUTH_DOMAIN = 'sulla-cloud-auth-v1';

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
  version:    typeof VERSION;
  algorithm:  'xchacha20-poly1305';
  nonce:      Base64;
  ciphertext: Base64;
}

export interface WrappedKeyPair {
  publicKey:           Base64;
  encryptedPrivateKey: EncryptedEnvelope;
}

export interface EncryptedItem {
  version:              typeof VERSION;
  encryptedItemKey:     EncryptedEnvelope;
  ciphertext:           EncryptedEnvelope;
  agentWrappedItemKey?: PublicKeyEnvelope;
}

export interface ItemContext {
  itemId:  string;
  ownerId: string;
}

export interface PublicKeyEnvelope {
  version:    typeof VERSION;
  algorithm:  'x25519-sealed-box';
  ciphertext: Base64;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function ready(): Promise<void> {
  await sodium.ready;
}

function b64(bytes: Uint8Array): Base64 {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function bytes(value: Base64): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function assertKey(key: Uint8Array, label: string): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`${ label } must be ${ KEY_BYTES } bytes`);
  }
}

function itemAssociatedDataImplementation(purpose: 'key' | 'ciphertext', context: ItemContext): string {
  if (!context.itemId || !context.ownerId) {
    throw new Error('Item context requires an item id and owner id');
  }
  return `sulla:item:${ purpose }:v1:${ JSON.stringify([context.ownerId, context.itemId]) }`;
}

async function deriveMasterKeyImplementation(
  masterPassword: string,
  salt?: Base64,
  parameters: Argon2idParameters = DEFAULT_ARGON2ID,
): Promise<DerivedMasterKey> {
  await ready();
  if (!masterPassword) {
    throw new Error('Master password cannot be empty');
  }
  const saltBytes = salt ? bytes(salt) : sodium.randombytes_buf(SALT_BYTES);
  if (saltBytes.byteLength !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error(`Argon2id salt must be ${ sodium.crypto_pwhash_SALTBYTES } bytes`);
  }
  const key = sodium.crypto_pwhash(
    KEY_BYTES,
    masterPassword,
    saltBytes,
    parameters.operations,
    parameters.memoryBytes,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return { key, salt: b64(saltBytes), parameters };
}

async function deriveAccountAuthHashImplementation(masterKey: Uint8Array): Promise<Base64> {
  await ready();
  assertKey(masterKey, 'Master key');
  return b64(sodium.crypto_generichash(KEY_BYTES, textEncoder.encode(CLOUD_AUTH_DOMAIN), masterKey));
}

async function deriveLoginHashImplementation(masterKey: Uint8Array): Promise<Base64> {
  await ready();
  assertKey(masterKey, 'Master key');
  return b64(sodium.crypto_generichash(KEY_BYTES, textEncoder.encode('sulla-vault-login-v1'), masterKey));
}

async function deriveOrgJoinHashImplementation(joinPassword: string, orgId: string): Promise<Base64> {
  await ready();
  if (!joinPassword || !orgId) {
    throw new Error('Join password and organization id are required');
  }
  const input = textEncoder.encode(`sulla:org-join:v1:${ orgId }\0${ joinPassword }`);
  return b64(sodium.crypto_generichash(KEY_BYTES, input, null));
}

async function publicKeyFingerprintImplementation(publicKey: Base64): Promise<string> {
  await ready();
  return b64(sodium.crypto_generichash(8, bytes(publicKey), null));
}

async function generateKeyImplementation(): Promise<Uint8Array> {
  await ready();
  return sodium.randombytes_buf(KEY_BYTES);
}

async function encryptWithKeyImplementation(
  plaintext: Uint8Array,
  key: Uint8Array,
  context: string,
): Promise<EncryptedEnvelope> {
  await ready();
  assertKey(key, 'Encryption key');
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    textEncoder.encode(context),
    null,
    nonce,
    key,
  );
  return { version: VERSION, algorithm: 'xchacha20-poly1305', nonce: b64(nonce), ciphertext: b64(ciphertext) };
}

async function decryptWithKeyImplementation(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  await ready();
  assertKey(key, 'Encryption key');
  if (envelope.version !== VERSION || envelope.algorithm !== 'xchacha20-poly1305') {
    throw new Error('Unsupported encrypted envelope');
  }
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    bytes(envelope.ciphertext),
    textEncoder.encode(context),
    bytes(envelope.nonce),
    key,
  );
}

async function createUserKeyImplementation(masterKey: Uint8Array): Promise<{ userKey: Uint8Array; encryptedUserKey: EncryptedEnvelope }> {
  const userKey = await generateKeyImplementation();
  return { userKey, encryptedUserKey: await encryptWithKeyImplementation(userKey, masterKey, 'sulla:user-key:v1') };
}

function unwrapUserKeyImplementation(encryptedUserKey: EncryptedEnvelope, masterKey: Uint8Array): Promise<Uint8Array> {
  return decryptWithKeyImplementation(encryptedUserKey, masterKey, 'sulla:user-key:v1');
}

async function encryptItemImplementation(
  plaintext: Uint8Array | string,
  ownerKey: Uint8Array,
  context: ItemContext,
  agentPublicKey?: Base64,
): Promise<EncryptedItem> {
  const itemKey = await generateKeyImplementation();
  const payload = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;
  return {
    version:             VERSION,
    encryptedItemKey:    await encryptWithKeyImplementation(itemKey, ownerKey, itemAssociatedDataImplementation('key', context)),
    ciphertext:          await encryptWithKeyImplementation(payload, itemKey, itemAssociatedDataImplementation('ciphertext', context)),
    agentWrappedItemKey: agentPublicKey ? await wrapItemKeyForAgent(itemKey, agentPublicKey) : undefined,
  };
}

async function decryptItemImplementation(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<Uint8Array> {
  if (item.version !== VERSION) {
    throw new Error('Unsupported item version');
  }
  const itemKey = await decryptWithKeyImplementation(item.encryptedItemKey, ownerKey, itemAssociatedDataImplementation('key', context));
  return decryptWithKeyImplementation(item.ciphertext, itemKey, itemAssociatedDataImplementation('ciphertext', context));
}

async function decryptItemTextImplementation(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<string> {
  return textDecoder.decode(await decryptItemImplementation(item, ownerKey, context));
}

async function createUserKeyPairImplementation(userKey: Uint8Array): Promise<WrappedKeyPair & { privateKey: Uint8Array }> {
  await ready();
  const pair = sodium.crypto_box_keypair();
  return {
    publicKey:           b64(pair.publicKey),
    privateKey:          pair.privateKey,
    encryptedPrivateKey: await encryptWithKeyImplementation(pair.privateKey, userKey, 'sulla:user-private-key:v1'),
  };
}

function unwrapUserPrivateKeyImplementation(encryptedPrivateKey: EncryptedEnvelope, userKey: Uint8Array): Promise<Uint8Array> {
  return decryptWithKeyImplementation(encryptedPrivateKey, userKey, 'sulla:user-private-key:v1');
}

async function wrapKeyToPublicKeyImplementation(key: Uint8Array, recipientPublicKey: Base64): Promise<PublicKeyEnvelope> {
  await ready();
  assertKey(key, 'Wrapped key');
  const ciphertext = sodium.crypto_box_seal(key, bytes(recipientPublicKey));
  return { version: VERSION, algorithm: 'x25519-sealed-box', ciphertext: b64(ciphertext) };
}

async function unwrapKeyFromPublicKeyImplementation(
  envelope: PublicKeyEnvelope,
  recipientPublicKey: Base64,
  recipientPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  if (envelope.version !== VERSION || envelope.algorithm !== 'x25519-sealed-box') {
    throw new Error('Unsupported public-key envelope');
  }
  return sodium.crypto_box_seal_open(bytes(envelope.ciphertext), bytes(recipientPublicKey), recipientPrivateKey);
}

export const wrapOrgKeyForMember = wrapKeyToPublicKeyImplementation;
export const unwrapOrgKeyForMember = unwrapKeyFromPublicKeyImplementation;

function wrapCollectionKeyImplementation(collectionKey: Uint8Array, orgKey: Uint8Array): Promise<EncryptedEnvelope> {
  return encryptWithKeyImplementation(collectionKey, orgKey, 'sulla:collection-key:v1');
}

function unwrapCollectionKeyImplementation(encryptedCollectionKey: EncryptedEnvelope, orgKey: Uint8Array): Promise<Uint8Array> {
  return decryptWithKeyImplementation(encryptedCollectionKey, orgKey, 'sulla:collection-key:v1');
}

export const wrapItemKeyForAgent = wrapKeyToPublicKeyImplementation;
export const unwrapItemKeyForAgent = unwrapKeyFromPublicKeyImplementation;
export * from './itemSchema.js';
export * from './customFields.js';
export * from './filesKeyBundle.js';
export { FilesTransportEnvelopeService, type FilesTransportEnvelope } from './filesTransportEnvelope.js';

/** Static compatibility facade for deterministic vault crypto behavior. */
export class VaultCrypto {
  static readonly itemAssociatedData = itemAssociatedDataImplementation;
  static readonly deriveMasterKey = deriveMasterKeyImplementation;
  static readonly deriveAccountAuthHash = deriveAccountAuthHashImplementation;
  static readonly deriveLoginHash = deriveLoginHashImplementation;
  static readonly deriveOrgJoinHash = deriveOrgJoinHashImplementation;
  static readonly publicKeyFingerprint = publicKeyFingerprintImplementation;
  static readonly generateKey = generateKeyImplementation;
  static readonly encryptWithKey = encryptWithKeyImplementation;
  static readonly decryptWithKey = decryptWithKeyImplementation;
  static readonly createUserKey = createUserKeyImplementation;
  static readonly unwrapUserKey = unwrapUserKeyImplementation;
  static readonly encryptItem = encryptItemImplementation;
  static readonly decryptItem = decryptItemImplementation;
  static readonly decryptItemText = decryptItemTextImplementation;
  static readonly createUserKeyPair = createUserKeyPairImplementation;
  static readonly unwrapUserPrivateKey = unwrapUserPrivateKeyImplementation;
  static readonly wrapKeyToPublicKey = wrapKeyToPublicKeyImplementation;
  static readonly unwrapKeyFromPublicKey = unwrapKeyFromPublicKeyImplementation;
  static readonly wrapCollectionKey = wrapCollectionKeyImplementation;
  static readonly unwrapCollectionKey = unwrapCollectionKeyImplementation;
}

export const itemAssociatedData = VaultCrypto.itemAssociatedData;
export const deriveMasterKey = VaultCrypto.deriveMasterKey;
export const deriveAccountAuthHash = VaultCrypto.deriveAccountAuthHash;
export const deriveLoginHash = VaultCrypto.deriveLoginHash;
export const deriveOrgJoinHash = VaultCrypto.deriveOrgJoinHash;
export const publicKeyFingerprint = VaultCrypto.publicKeyFingerprint;
export const generateKey = VaultCrypto.generateKey;
export const encryptWithKey = VaultCrypto.encryptWithKey;
export const decryptWithKey = VaultCrypto.decryptWithKey;
export const createUserKey = VaultCrypto.createUserKey;
export const unwrapUserKey = VaultCrypto.unwrapUserKey;
export const encryptItem = VaultCrypto.encryptItem;
export const decryptItem = VaultCrypto.decryptItem;
export const decryptItemText = VaultCrypto.decryptItemText;
export const createUserKeyPair = VaultCrypto.createUserKeyPair;
export const unwrapUserPrivateKey = VaultCrypto.unwrapUserPrivateKey;
export const wrapKeyToPublicKey = VaultCrypto.wrapKeyToPublicKey;
export const unwrapKeyFromPublicKey = VaultCrypto.unwrapKeyFromPublicKey;
export const wrapCollectionKey = VaultCrypto.wrapCollectionKey;
export const unwrapCollectionKey = VaultCrypto.unwrapCollectionKey;
