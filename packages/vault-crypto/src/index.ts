import sodium from 'libsodium-wrappers-sumo';

const VERSION = 1 as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 24;

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

export function itemAssociatedData(purpose: 'key' | 'ciphertext', context: ItemContext): string {
  if (!context.itemId || !context.ownerId) {
    throw new Error('Item context requires an item id and owner id');
  }
  return `sulla:item:${ purpose }:v1:${ JSON.stringify([context.ownerId, context.itemId]) }`;
}

export async function deriveMasterKey(
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

export async function deriveLoginHash(masterKey: Uint8Array): Promise<Base64> {
  await ready();
  assertKey(masterKey, 'Master key');
  return b64(sodium.crypto_generichash(KEY_BYTES, textEncoder.encode('sulla-vault-login-v1'), masterKey));
}

export async function deriveOrgJoinHash(joinPassword: string, orgId: string): Promise<Base64> {
  await ready();
  if (!joinPassword || !orgId) {
    throw new Error('Join password and organization id are required');
  }
  const input = textEncoder.encode(`sulla:org-join:v1:${ orgId }\0${ joinPassword }`);
  return b64(sodium.crypto_generichash(KEY_BYTES, input, null));
}

export async function publicKeyFingerprint(publicKey: Base64): Promise<string> {
  await ready();
  return b64(sodium.crypto_generichash(8, bytes(publicKey), null));
}

export async function generateKey(): Promise<Uint8Array> {
  await ready();
  return sodium.randombytes_buf(KEY_BYTES);
}

export async function encryptWithKey(
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

export async function decryptWithKey(
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

export async function createUserKey(masterKey: Uint8Array): Promise<{ userKey: Uint8Array; encryptedUserKey: EncryptedEnvelope }> {
  const userKey = await generateKey();
  return { userKey, encryptedUserKey: await encryptWithKey(userKey, masterKey, 'sulla:user-key:v1') };
}

export function unwrapUserKey(encryptedUserKey: EncryptedEnvelope, masterKey: Uint8Array): Promise<Uint8Array> {
  return decryptWithKey(encryptedUserKey, masterKey, 'sulla:user-key:v1');
}

export async function encryptItem(
  plaintext: Uint8Array | string,
  ownerKey: Uint8Array,
  context: ItemContext,
  agentPublicKey?: Base64,
): Promise<EncryptedItem> {
  const itemKey = await generateKey();
  const payload = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;
  return {
    version:             VERSION,
    encryptedItemKey:    await encryptWithKey(itemKey, ownerKey, itemAssociatedData('key', context)),
    ciphertext:          await encryptWithKey(payload, itemKey, itemAssociatedData('ciphertext', context)),
    agentWrappedItemKey: agentPublicKey ? await wrapItemKeyForAgent(itemKey, agentPublicKey) : undefined,
  };
}

export async function decryptItem(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<Uint8Array> {
  if (item.version !== VERSION) {
    throw new Error('Unsupported item version');
  }
  const itemKey = await decryptWithKey(item.encryptedItemKey, ownerKey, itemAssociatedData('key', context));
  return decryptWithKey(item.ciphertext, itemKey, itemAssociatedData('ciphertext', context));
}

export async function decryptItemText(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<string> {
  return textDecoder.decode(await decryptItem(item, ownerKey, context));
}

export async function createUserKeyPair(userKey: Uint8Array): Promise<WrappedKeyPair & { privateKey: Uint8Array }> {
  await ready();
  const pair = sodium.crypto_box_keypair();
  return {
    publicKey:           b64(pair.publicKey),
    privateKey:          pair.privateKey,
    encryptedPrivateKey: await encryptWithKey(pair.privateKey, userKey, 'sulla:user-private-key:v1'),
  };
}

export function unwrapUserPrivateKey(encryptedPrivateKey: EncryptedEnvelope, userKey: Uint8Array): Promise<Uint8Array> {
  return decryptWithKey(encryptedPrivateKey, userKey, 'sulla:user-private-key:v1');
}

export async function wrapKeyToPublicKey(key: Uint8Array, recipientPublicKey: Base64): Promise<PublicKeyEnvelope> {
  await ready();
  assertKey(key, 'Wrapped key');
  const ciphertext = sodium.crypto_box_seal(key, bytes(recipientPublicKey));
  return { version: VERSION, algorithm: 'x25519-sealed-box', ciphertext: b64(ciphertext) };
}

export async function unwrapKeyFromPublicKey(
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

export const wrapOrgKeyForMember = wrapKeyToPublicKey;
export const unwrapOrgKeyForMember = unwrapKeyFromPublicKey;

export function wrapCollectionKey(collectionKey: Uint8Array, orgKey: Uint8Array): Promise<EncryptedEnvelope> {
  return encryptWithKey(collectionKey, orgKey, 'sulla:collection-key:v1');
}

export function unwrapCollectionKey(encryptedCollectionKey: EncryptedEnvelope, orgKey: Uint8Array): Promise<Uint8Array> {
  return decryptWithKey(encryptedCollectionKey, orgKey, 'sulla:collection-key:v1');
}

export const wrapItemKeyForAgent = wrapKeyToPublicKey;
export const unwrapItemKeyForAgent = unwrapKeyFromPublicKey;
export * from './itemSchema.js';
export * from './filesKeyBundle.js';
