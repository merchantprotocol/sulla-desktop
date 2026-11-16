// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultCipher } from './VaultCipher.js';
import type { Base64, EncryptedEnvelope, PublicKeyEnvelope } from './types.js';

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
  version:    1;
  algorithm:  'x25519+xchacha20-poly1305';
  purpose:    FilesKeyBundlePurpose;
  context:    FilesKeyBundleContext;
  wrappedKey: PublicKeyEnvelope;
  dataKey:    EncryptedEnvelope;
  dedupKey:   EncryptedEnvelope;
}

/** Seals, opens and re-wraps Files collection key bundles. Transient key bytes are zeroed. */
export class FilesKeyBundleCodec {
  private static readonly VERSION = 1 as const;
  private static readonly ALGORITHM = 'x25519+xchacha20-poly1305' as const;
  private static readonly KEY_BYTES = 32;

  constructor(private readonly cipher: VaultCipher) {}

  associatedData(purpose: FilesKeyBundlePurpose, key: 'data' | 'dedup', context: FilesKeyBundleContext): string {
    this.assertContext(context);
    return `sulla:files:key-bundle:${ purpose }:${ key }:v1:${ JSON.stringify([
      context.principalId,
      context.collectionId,
      context.keyVersion,
      context.epoch,
    ]) }`;
  }

  async seal(
    material: FilesCollectionKeyMaterial,
    context: FilesKeyBundleContext,
    purpose: FilesKeyBundlePurpose,
    recipientPublicKey: Base64,
  ): Promise<FilesKeyBundleEnvelope> {
    this.assertContext(context);
    this.assertMaterial(material);
    const bundleKey = await this.cipher.generateKey();
    try {
      return {
        version:    FilesKeyBundleCodec.VERSION,
        algorithm:  FilesKeyBundleCodec.ALGORITHM,
        purpose,
        context:    { ...context },
        wrappedKey: await this.cipher.wrapKeyToPublicKey(bundleKey, recipientPublicKey),
        dataKey:    await this.cipher.encryptWithKey(material.dataKey, bundleKey, this.associatedData(purpose, 'data', context)),
        dedupKey:   await this.cipher.encryptWithKey(material.dedupKey, bundleKey, this.associatedData(purpose, 'dedup', context)),
      };
    } finally {
      bundleKey.fill(0);
    }
  }

  async open(
    envelope: FilesKeyBundleEnvelope,
    expectedContext: FilesKeyBundleContext,
    expectedPurpose: FilesKeyBundlePurpose,
    recipientPublicKey: Base64,
    recipientPrivateKey: Uint8Array,
  ): Promise<FilesCollectionKeyMaterial> {
    this.assertContext(expectedContext);
    if (envelope.version !== FilesKeyBundleCodec.VERSION || envelope.algorithm !== FilesKeyBundleCodec.ALGORITHM ||
        envelope.purpose !== expectedPurpose || !this.sameContext(envelope.context, expectedContext)) {
      throw new Error('Files key bundle context mismatch');
    }
    const bundleKey = await this.cipher.unwrapKeyFromPublicKey(envelope.wrappedKey, recipientPublicKey, recipientPrivateKey);
    try {
      const dataKey = await this.cipher.decryptWithKey(
        envelope.dataKey,
        bundleKey,
        this.associatedData(expectedPurpose, 'data', expectedContext),
      );
      let dedupKey: Uint8Array | undefined;
      try {
        dedupKey = await this.cipher.decryptWithKey(
          envelope.dedupKey,
          bundleKey,
          this.associatedData(expectedPurpose, 'dedup', expectedContext),
        );
        const material = { dataKey, dedupKey };
        this.assertMaterial(material);
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
  async rewrapForDevice(
    authorityEnvelope: FilesKeyBundleEnvelope,
    expectedContext: FilesKeyBundleContext,
    authorityPublicKey: Base64,
    authorityPrivateKey: Uint8Array,
    devicePublicKey: Base64,
  ): Promise<FilesKeyBundleEnvelope> {
    const material = await this.open(authorityEnvelope, expectedContext, 'authority-custody', authorityPublicKey, authorityPrivateKey);
    try {
      return await this.seal(material, expectedContext, 'device-recovery', devicePublicKey);
    } finally {
      material.dataKey.fill(0);
      material.dedupKey.fill(0);
    }
  }

  private assertContext(context: FilesKeyBundleContext): void {
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

  private assertMaterial(material: FilesCollectionKeyMaterial): void {
    if (material.dataKey.byteLength !== FilesKeyBundleCodec.KEY_BYTES ||
        material.dedupKey.byteLength !== FilesKeyBundleCodec.KEY_BYTES) {
      throw new Error('Files collection keys must be 32 bytes');
    }
  }

  private sameContext(left: FilesKeyBundleContext, right: FilesKeyBundleContext): boolean {
    return left.collectionId === right.collectionId && left.principalId === right.principalId &&
      left.keyVersion === right.keyVersion && left.epoch === right.epoch;
  }
}
