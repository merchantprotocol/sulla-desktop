// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { timingSafeEqual } from 'node:crypto';

import {
  generateX25519RecipientKeyPair,
  openFilesKeyBundle,
  type FilesKeyBundleContext,
} from '@sulla/vault-crypto';

import { TransactionRunner } from './FilesTransaction.js';
import { FilesKeyBundleRecovery, type FilesKeyBundleAuthority } from './keyBundleRecovery.js';
import { CollectionKeyRepository, type CollectionKeyContextRow } from './Repositories/CollectionKeyRepository.js';
import { RemoteKeyRecoveryRepository } from './Repositories/RemoteKeyRecoveryRepository.js';

import type { FilesKeyring } from './keyring.js';
import type pg from 'pg';

type CurrentKeyContextRow = CollectionKeyContextRow;

/**
 * Proves that Vault can recover the exact current random collection keys.
 * Only opaque envelopes cross the service boundary; recovered key bytes are
 * compared in memory, zeroed, and never returned to callers.
 */
export class SecureCollectionKeyExchange {
  constructor(
    private readonly db:pg.Pool,
    private readonly keyring:FilesKeyring,
    private readonly authority:FilesKeyBundleAuthority,
    private readonly recovery = new FilesKeyBundleRecovery(db, keyring, authority),
    private readonly collectionKeys = new CollectionKeyRepository(db),
    private readonly remoteRecovery = new RemoteKeyRecoveryRepository(db),
    private readonly transactions = new TransactionRunner(db),
  ) {}

  async verifyRemoteRecoverability(collectionId:string):Promise<FilesKeyBundleContext> {
    const row = await this.currentContext(collectionId);
    if (row.key_origin !== 'random' || row.compatibility_state !== 'native') {
      throw new Error('Online-only requires a native random collection key');
    }
    const context:FilesKeyBundleContext = {
      collectionId: row.collection_id,
      principalId:  row.owner_user_id,
      keyVersion:   Number(row.key_version),
      epoch:        Number(row.key_epoch),
    };
    const bundle = await this.recovery.enrollCollection(collectionId);
    if (!sameContext(bundle.context, context)) throw new Error('Persisted recovery bundle context is stale');

    const device = await generateX25519RecipientKeyPair();
    const local = await this.keyring.copyKeys(collectionId);
    let recovered:{ dataKey: Uint8Array; dedupKey: Uint8Array } | undefined;
    try {
      const envelope = await this.authority.authorizeDeviceRecovery({ context, devicePublicKey: device.publicKey });
      recovered = await openFilesKeyBundle(envelope, context, 'device-recovery', device.publicKey, device.privateKey);
      if (!equal(local.data, recovered.dataKey) || !equal(local.dedup, recovered.dedupKey)) {
        throw new Error('Remote custody recovered different collection keys');
      }

      await this.transactions.run('files-remote-key-recovery', async client => {
        const current = await this.currentContext(collectionId, client);
        if (!sameRowContext(current, context) || current.key_origin !== 'random' || current.compatibility_state !== 'native') {
          throw new Error('Collection key context changed during remote recovery verification');
        }
        await this.remoteRecovery.recordVerified(context, bundle.authorityKeyId, client);
      });
      return context;
    } finally {
      device.privateKey.fill(0);
      local.data.fill(0);
      local.dedup.fill(0);
      recovered?.dataKey.fill(0);
      recovered?.dedupKey.fill(0);
    }
  }

  private async currentContext(collectionId:string, query:Pick<pg.Pool, 'query'> = this.db):Promise<CurrentKeyContextRow> {
    const row = await this.collectionKeys.lockKeyContext(collectionId, query);
    if (!row) throw new Error('Collection key context is unavailable');
    return row;
  }
}

function sameContext(left:FilesKeyBundleContext, right:FilesKeyBundleContext):boolean {
  return left.collectionId === right.collectionId && left.principalId === right.principalId &&
    left.keyVersion === right.keyVersion && left.epoch === right.epoch;
}

function sameRowContext(row:CurrentKeyContextRow, context:FilesKeyBundleContext):boolean {
  return row.collection_id === context.collectionId && row.owner_user_id === context.principalId &&
    Number(row.key_version) === context.keyVersion && Number(row.key_epoch) === context.epoch;
}

function equal(left:Uint8Array, right:Uint8Array):boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
