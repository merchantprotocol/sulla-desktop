// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export interface StoredFilesKeyBundle {
  context:        FilesKeyBundleContext;
  authorityKeyId: string;
  envelope:       FilesKeyBundleEnvelope;
}

interface BundleRow {
  collection_id:    string;
  principal_id:     string;
  key_version:      number;
  key_epoch:        number;
  authority_key_id: string;
  authority_bundle: FilesKeyBundleEnvelope;
}

/**
 * files_collection_key_bundles: immutable opaque Vault-custody envelopes, one
 * per exact (collection, principal, key version, epoch) context.
 */
export class CollectionKeyBundleRepository {
  constructor(private readonly db:Queryable) {}

  /** Inserts a candidate; a concurrent winner for the same context is kept (ON CONFLICT DO NOTHING). */
  async insertIfAbsent(bundle:StoredFilesKeyBundle, client:Queryable = this.db):Promise<void> {
    const { context } = bundle;
    await client.query(
      `INSERT INTO files_collection_key_bundles
          (collection_id,principal_id,key_version,key_epoch,authority_key_id,authority_bundle)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [context.collectionId, context.principalId, context.keyVersion, context.epoch,
        bundle.authorityKeyId, bundle.envelope],
    );
  }

  async find(context:FilesKeyBundleContext, client:Queryable = this.db):Promise<StoredFilesKeyBundle | undefined> {
    const row = (await client.query(
      `SELECT collection_id,principal_id,key_version,key_epoch,authority_key_id,authority_bundle
         FROM files_collection_key_bundles
        WHERE collection_id=$1 AND principal_id=$2 AND key_version=$3 AND key_epoch=$4`,
      [context.collectionId, context.principalId, context.keyVersion, context.epoch],
    )).rows[0] as BundleRow | undefined;
    return row ? CollectionKeyBundleRepository.toBundle(row) : undefined;
  }

  /** Records the first successful Vault registration; later calls keep the original timestamp. */
  async markRegistered(context:FilesKeyBundleContext, client:Queryable = this.db):Promise<void> {
    await client.query(
      `UPDATE files_collection_key_bundles SET authority_registered_at=COALESCE(authority_registered_at,NOW())
        WHERE collection_id=$1 AND principal_id=$2 AND key_version=$3 AND key_epoch=$4`,
      [context.collectionId, context.principalId, context.keyVersion, context.epoch],
    );
  }

  /** Bundles matching the current key context of every native random collection the principal owns. */
  async currentBundlesForPrincipal(principalId:string, client:Queryable = this.db):Promise<StoredFilesKeyBundle[]> {
    const rows = (await client.query(
      `SELECT b.collection_id,b.principal_id,b.key_version,b.key_epoch,b.authority_key_id,b.authority_bundle
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
         JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id
          AND b.principal_id=c.owner_user_id AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
        WHERE c.owner_user_id=$1 AND c.compatibility_state='native' AND c.published=TRUE AND c.legacy_source=FALSE
          AND k.key_origin='random'
        ORDER BY b.collection_id`,
      [principalId],
    )).rows as BundleRow[];
    return rows.map(row => CollectionKeyBundleRepository.toBundle(row));
  }

  private static toBundle(row:BundleRow):StoredFilesKeyBundle {
    return {
      context: {
        collectionId: row.collection_id,
        principalId:  row.principal_id,
        keyVersion:   Number(row.key_version),
        epoch:        Number(row.key_epoch),
      },
      authorityKeyId: row.authority_key_id,
      envelope:       row.authority_bundle,
    };
  }
}
