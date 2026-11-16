// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  generateX25519RecipientKeyPair,
  openFilesKeyBundle,
  sealFilesKeyBundle,
  type Base64,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
} from '@sulla/vault-crypto';

import { CollectionKeyBundleRepository, type StoredFilesKeyBundle } from './Repositories/CollectionKeyBundleRepository.js';
import { CollectionKeyRepository } from './Repositories/CollectionKeyRepository.js';

import type { FilesKeyring } from './keyring.js';
import type pg from 'pg';

export type { StoredFilesKeyBundle } from './Repositories/CollectionKeyBundleRepository.js';

/** Implemented by Vault. It owns authorization and custody-key plaintext. */
export interface FilesKeyBundleAuthority {
  custodyRecipient(context:FilesKeyBundleContext):Promise<{ keyId: string; publicKey: Base64 }>;
  registerBundle(bundle:StoredFilesKeyBundle):Promise<void>;
  authorizeDeviceRecovery(request:{ context: FilesKeyBundleContext; devicePublicKey: Base64 }):Promise<FilesKeyBundleEnvelope>;
}

export class FilesKeyBundleRecovery {
  constructor(
    private readonly db:pg.Pool,
    private readonly keyring:FilesKeyring,
    private readonly authority:FilesKeyBundleAuthority,
    private readonly collectionKeys = new CollectionKeyRepository(db),
    private readonly bundles = new CollectionKeyBundleRepository(db),
  ) {}

  async enrollAllCollections(principalId:string):Promise<number> {
    if (!principalId) throw new Error('Files recovery enrollment requires a principal');
    const collectionIds = await this.collectionKeys.ownedRandomCollectionIds(principalId);
    for (const collectionId of collectionIds) await this.enrollCollection(collectionId);
    return collectionIds.length;
  }

  async enrollCollection(collectionId:string):Promise<StoredFilesKeyBundle> {
    const row = await this.collectionKeys.findKeyContext(collectionId);
    if (!row) throw new Error('Collection key unavailable');
    if (row.key_origin !== 'random' || row.compatibility_state !== 'native') {
      throw new Error('Legacy Files keys require the separate secure import flow');
    }
    const context:FilesKeyBundleContext = {
      collectionId: row.collection_id,
      principalId:  row.owner_user_id,
      keyVersion:   Number(row.key_version),
      epoch:        Number(row.key_epoch),
    };
    const existing = await this.bundles.find(context);
    if (existing) {
      await this.registerPersisted(existing);
      return existing;
    }
    const recipient = await this.authority.custodyRecipient(context);
    const keys = await this.keyring.copyKeys(collectionId);
    try {
      const candidate:StoredFilesKeyBundle = {
        context:        { ...context },
        authorityKeyId: recipient.keyId,
        envelope:       await sealFilesKeyBundle(
          { dataKey: keys.data, dedupKey: keys.dedup },
          context,
          'authority-custody',
          recipient.publicKey,
        ),
      };
      await this.bundles.insertIfAbsent(candidate);
      // Re-read the immutable winner. Concurrent enrollments may have produced
      // different randomized candidates, but only the persisted envelope is
      // ever registered with Vault.
      const persisted = await this.bundles.find(context);
      if (!persisted) throw new Error('Files recovery bundle was not persisted');
      await this.registerPersisted(persisted);
      return persisted;
    } finally {
      keys.data.fill(0); keys.dedup.fill(0);
    }
  }

  private async registerPersisted(bundle:StoredFilesKeyBundle):Promise<void> {
    await this.authority.registerBundle(bundle);
    await this.bundles.markRegistered(bundle.context);
  }

  async recoverDeviceMaster(master:Buffer, principalId:string):Promise<number> {
    if (!principalId) throw new Error('Files recovery requires a principal');
    const bundles = await this.bundles.currentBundlesForPrincipal(principalId);
    const collectionRows = await this.collectionKeys.publishedCollectionStates();
    if (collectionRows.some(row => row.key_origin !== 'random' || row.compatibility_state !== 'native')) {
      throw new Error('Legacy Files keys require the separate secure import flow');
    }
    if (collectionRows.some(row => row.owner_user_id !== principalId)) {
      throw new Error('Files device recovery currently requires one owner principal for every local collection');
    }
    if (bundles.length === 0 || bundles.length !== collectionRows.length ||
        collectionRows.some((row, index) => row.collection_id !== bundles[index]?.context.collectionId)) {
      throw new Error('Files recovery is incomplete; no local keys were changed');
    }

    const device = await generateX25519RecipientKeyPair();
    const recovered = new Map<string, { data: Uint8Array; dedup: Uint8Array }>();
    try {
      for (const stored of bundles) {
        // Vault resolves its own registered envelope by this exact context;
        // Files never supplies an envelope as an authorization assertion.
        const deviceEnvelope = await this.authority.authorizeDeviceRecovery({ context: stored.context, devicePublicKey: device.publicKey });
        const keys = await openFilesKeyBundle(
          deviceEnvelope,
          stored.context,
          'device-recovery',
          device.publicKey,
          device.privateKey,
        );
        recovered.set(stored.context.collectionId, { data: keys.dataKey, dedup: keys.dedupKey });
      }
      await this.keyring.installRecoveredMaster(master, recovered);
      return recovered.size;
    } finally {
      device.privateKey.fill(0);
      for (const keys of recovered.values()) { keys.data.fill(0); keys.dedup.fill(0) }
    }
  }
}
