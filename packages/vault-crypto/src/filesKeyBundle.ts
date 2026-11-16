// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Legacy named API for Files key bundles. The logic lives in FilesKeyBundleCodec; these functions
// delegate to the shared VaultCrypto instance so existing callers keep working unchanged.

import type {
  FilesCollectionKeyMaterial,
  FilesKeyBundleContext,
  FilesKeyBundleEnvelope,
  FilesKeyBundlePurpose,
} from './FilesKeyBundleCodec.js';
import type { Base64, X25519RecipientKeyPair } from './types.js';
import { VaultCrypto } from './VaultCrypto.js';

export type {
  FilesCollectionKeyMaterial,
  FilesKeyBundleContext,
  FilesKeyBundleEnvelope,
  FilesKeyBundlePurpose,
} from './FilesKeyBundleCodec.js';
export type { X25519RecipientKeyPair } from './types.js';

export function filesKeyBundleAssociatedData(
  purpose: FilesKeyBundlePurpose,
  key: 'data' | 'dedup',
  context: FilesKeyBundleContext,
): string {
  return VaultCrypto.shared().filesKeyBundles.associatedData(purpose, key, context);
}

export function generateX25519RecipientKeyPair(): Promise<X25519RecipientKeyPair> {
  return VaultCrypto.shared().cipher.generateKeyPair();
}

export function sealFilesKeyBundle(
  material: FilesCollectionKeyMaterial,
  context: FilesKeyBundleContext,
  purpose: FilesKeyBundlePurpose,
  recipientPublicKey: Base64,
): Promise<FilesKeyBundleEnvelope> {
  return VaultCrypto.shared().filesKeyBundles.seal(material, context, purpose, recipientPublicKey);
}

export function openFilesKeyBundle(
  envelope: FilesKeyBundleEnvelope,
  expectedContext: FilesKeyBundleContext,
  expectedPurpose: FilesKeyBundlePurpose,
  recipientPublicKey: Base64,
  recipientPrivateKey: Uint8Array,
): Promise<FilesCollectionKeyMaterial> {
  return VaultCrypto.shared().filesKeyBundles.open(envelope, expectedContext, expectedPurpose, recipientPublicKey, recipientPrivateKey);
}

/** Runs inside the custody authority after its principal/collection checks pass. */
export function rewrapFilesKeyBundleForDevice(
  authorityEnvelope: FilesKeyBundleEnvelope,
  expectedContext: FilesKeyBundleContext,
  authorityPublicKey: Base64,
  authorityPrivateKey: Uint8Array,
  devicePublicKey: Base64,
): Promise<FilesKeyBundleEnvelope> {
  return VaultCrypto.shared().filesKeyBundles.rewrapForDevice(
    authorityEnvelope, expectedContext, authorityPublicKey, authorityPrivateKey, devicePublicKey,
  );
}
