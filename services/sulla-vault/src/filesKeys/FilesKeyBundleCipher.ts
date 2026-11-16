// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  openFilesKeyBundle,
  rewrapFilesKeyBundleForDevice,
  type Base64,
  type FilesCollectionKeyMaterial,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
  type FilesKeyBundlePurpose,
} from '@sulla/vault-crypto';

/** The bundle crypto VaultFilesKeyBundleAuthority needs; swap in tests through the constructor. */
export interface FilesKeyBundleCipher {
  open(
    envelope:FilesKeyBundleEnvelope,
    expectedContext:FilesKeyBundleContext,
    expectedPurpose:FilesKeyBundlePurpose,
    recipientPublicKey:Base64,
    recipientPrivateKey:Uint8Array,
  ):Promise<FilesCollectionKeyMaterial>;
  rewrapForDevice(
    authorityEnvelope:FilesKeyBundleEnvelope,
    expectedContext:FilesKeyBundleContext,
    authorityPublicKey:Base64,
    authorityPrivateKey:Uint8Array,
    devicePublicKey:Base64,
  ):Promise<FilesKeyBundleEnvelope>;
}

/** Production cipher: the same @sulla/vault-crypto calls the authority always made. */
export class VaultCryptoFilesKeyBundleCipher implements FilesKeyBundleCipher {
  open(
    envelope:FilesKeyBundleEnvelope,
    expectedContext:FilesKeyBundleContext,
    expectedPurpose:FilesKeyBundlePurpose,
    recipientPublicKey:Base64,
    recipientPrivateKey:Uint8Array,
  ):Promise<FilesCollectionKeyMaterial> {
    return openFilesKeyBundle(envelope, expectedContext, expectedPurpose, recipientPublicKey, recipientPrivateKey);
  }

  rewrapForDevice(
    authorityEnvelope:FilesKeyBundleEnvelope,
    expectedContext:FilesKeyBundleContext,
    authorityPublicKey:Base64,
    authorityPrivateKey:Uint8Array,
    devicePublicKey:Base64,
  ):Promise<FilesKeyBundleEnvelope> {
    return rewrapFilesKeyBundleForDevice(authorityEnvelope, expectedContext, authorityPublicKey, authorityPrivateKey, devicePublicKey);
  }
}
