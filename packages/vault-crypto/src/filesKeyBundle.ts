import sodium from 'libsodium-wrappers-sumo';

import {
  decryptWithKey,
  encryptWithKey,
  generateKey,
  unwrapKeyFromPublicKey,
  wrapKeyToPublicKey,
  type Base64,
  type EncryptedEnvelope,
  type PublicKeyEnvelope,
} from './index.js';

const VERSION = 1 as const;
const KEY_BYTES = 32;

export type FilesKeyBundlePurpose = 'authority-custody' | 'device-recovery';

export interface FilesKeyBundleContext {
  collectionId: string;
  principalId:  string;
  keyVersion:   number;
  epoch:        number;
}

export interface FilesCollectionKeyMaterial {
  dataKey:  Uint8Array;
  dedupKey: Uint8Array;
}

/**
 * The only persistable representation of Files collection keys. The bundle key
 * is sealed to a recipient and the collection keys are context-bound with AEAD.
 */
export interface FilesKeyBundleEnvelope {
  version:    typeof VERSION;
  algorithm:  'x25519+xchacha20-poly1305';
  purpose:    FilesKeyBundlePurpose;
  context:    FilesKeyBundleContext;
  wrappedKey: PublicKeyEnvelope;
  dataKey:    EncryptedEnvelope;
  dedupKey:   EncryptedEnvelope;
}

export interface X25519RecipientKeyPair {
  publicKey:  Base64;
  privateKey: Uint8Array;
}

function assertContext(context: FilesKeyBundleContext): void {
  if (!context.collectionId || !context.principalId) {
    throw new Error('Files key bundle requires collection and principal ids');
  }
  if (!Number.isSafeInteger(context.keyVersion) || context.keyVersion < 1) {
    throw new Error('Files key bundle version must be a positive integer');
  }
  if (!Number.isSafeInteger(context.epoch) || context.epoch < 1) {
    throw new Error('Files key bundle epoch must be a positive integer');
  }
}

function assertMaterial(material: FilesCollectionKeyMaterial): void {
  if (material.dataKey.byteLength !== KEY_BYTES || material.dedupKey.byteLength !== KEY_BYTES) {
    throw new Error('Files collection keys must be 32 bytes');
  }
}

function sameContext(left: FilesKeyBundleContext, right: FilesKeyBundleContext): boolean {
  return left.collectionId === right.collectionId && left.principalId === right.principalId &&
    left.keyVersion === right.keyVersion && left.epoch === right.epoch;
}

export function filesKeyBundleAssociatedData(
  purpose: FilesKeyBundlePurpose,
  key: 'data' | 'dedup',
  context: FilesKeyBundleContext,
): string {
  assertContext(context);
  return `sulla:files:key-bundle:${ purpose }:${ key }:v1:${ JSON.stringify([
    context.principalId,
    context.collectionId,
    context.keyVersion,
    context.epoch,
  ]) }`;
}

export async function generateX25519RecipientKeyPair(): Promise<X25519RecipientKeyPair> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return {
    publicKey:  sodium.to_base64(pair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
    privateKey: pair.privateKey,
  };
}

export async function sealFilesKeyBundle(
  material: FilesCollectionKeyMaterial,
  context: FilesKeyBundleContext,
  purpose: FilesKeyBundlePurpose,
  recipientPublicKey: Base64,
): Promise<FilesKeyBundleEnvelope> {
  assertContext(context);
  assertMaterial(material);
  const bundleKey = await generateKey();
  try {
    return {
      version:    VERSION,
      algorithm:  'x25519+xchacha20-poly1305',
      purpose,
      context:    { ...context },
      wrappedKey: await wrapKeyToPublicKey(bundleKey, recipientPublicKey),
      dataKey:    await encryptWithKey(material.dataKey, bundleKey, filesKeyBundleAssociatedData(purpose, 'data', context)),
      dedupKey:   await encryptWithKey(material.dedupKey, bundleKey, filesKeyBundleAssociatedData(purpose, 'dedup', context)),
    };
  } finally {
    bundleKey.fill(0);
  }
}

export async function openFilesKeyBundle(
  envelope: FilesKeyBundleEnvelope,
  expectedContext: FilesKeyBundleContext,
  expectedPurpose: FilesKeyBundlePurpose,
  recipientPublicKey: Base64,
  recipientPrivateKey: Uint8Array,
): Promise<FilesCollectionKeyMaterial> {
  assertContext(expectedContext);
  if (envelope.version !== VERSION || envelope.algorithm !== 'x25519+xchacha20-poly1305' ||
      envelope.purpose !== expectedPurpose || !sameContext(envelope.context, expectedContext)) {
    throw new Error('Files key bundle context mismatch');
  }
  const bundleKey = await unwrapKeyFromPublicKey(envelope.wrappedKey, recipientPublicKey, recipientPrivateKey);
  try {
    const dataKey = await decryptWithKey(
      envelope.dataKey,
      bundleKey,
      filesKeyBundleAssociatedData(expectedPurpose, 'data', expectedContext),
    );
    let dedupKey:Uint8Array | undefined;
    try {
      dedupKey = await decryptWithKey(
        envelope.dedupKey,
        bundleKey,
        filesKeyBundleAssociatedData(expectedPurpose, 'dedup', expectedContext),
      );
      const material = { dataKey, dedupKey };
      assertMaterial(material);
      return material;
    } catch (error) {
      dataKey.fill(0);
      dedupKey?.fill(0);
      throw error;
    }
  } finally {
    bundleKey.fill(0);
  }
}

/** Runs inside the custody authority after its principal/collection checks pass. */
export async function rewrapFilesKeyBundleForDevice(
  authorityEnvelope: FilesKeyBundleEnvelope,
  expectedContext: FilesKeyBundleContext,
  authorityPublicKey: Base64,
  authorityPrivateKey: Uint8Array,
  devicePublicKey: Base64,
): Promise<FilesKeyBundleEnvelope> {
  const material = await openFilesKeyBundle(
    authorityEnvelope,
    expectedContext,
    'authority-custody',
    authorityPublicKey,
    authorityPrivateKey,
  );
  try {
    return await sealFilesKeyBundle(material, expectedContext, 'device-recovery', devicePublicKey);
  } finally {
    material.dataKey.fill(0);
    material.dedupKey.fill(0);
  }
}
