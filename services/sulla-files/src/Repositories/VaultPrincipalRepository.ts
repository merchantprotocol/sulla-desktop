// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export interface CollectionOwnerRow { id:string; owner_user_id:string }

/** Collection, share-link and key-bundle ownership reads/writes used to adopt the Vault principal. */
export class VaultPrincipalRepository {
  constructor(private readonly db:Queryable) {}

  /** Every collection's owner, row-locked. Must run inside a transaction. */
  async lockCollectionOwners(client:Queryable):Promise<CollectionOwnerRow[]> {
    return (await client.query<CollectionOwnerRow>('SELECT id::text,owner_user_id FROM collections FOR UPDATE')).rows;
  }

  /** True when any of the collections already has a custody bundle for a different principal. */
  async hasBundleForOtherPrincipal(collectionIds:string[], principalId:string, client:Queryable = this.db):Promise<boolean> {
    return Boolean((await client.query(
      'SELECT 1 FROM files_collection_key_bundles WHERE collection_id=ANY($1::uuid[]) AND principal_id<>$2 LIMIT 1',
      [collectionIds, principalId],
    )).rowCount);
  }

  /** Moves `fromOwner`'s share links on these collections (directly or via their files) to `principalId`. */
  async reassignShareLinks(collectionIds:string[], principalId:string, fromOwner:string, client:Queryable = this.db):Promise<void> {
    await client.query(
      `UPDATE file_share_links links SET owner_user_id=$2
          WHERE links.owner_user_id=$3 AND (
            links.collection_id=ANY($1::uuid[])
            OR EXISTS(SELECT 1 FROM files WHERE files.id=links.file_id AND files.collection_id=ANY($1::uuid[]))
          )`,
      [collectionIds, principalId, fromOwner],
    );
  }

  async reassignCollections(collectionIds:string[], principalId:string, client:Queryable = this.db):Promise<void> {
    await client.query('UPDATE collections SET owner_user_id=$2,updated_at=NOW() WHERE id=ANY($1::uuid[])', [collectionIds, principalId]);
  }
}
