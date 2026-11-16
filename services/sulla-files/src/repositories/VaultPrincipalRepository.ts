// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

interface CollectionOwnerRow { id: string; owner_user_id: string }

/** Owns the transactional SQL involved in adopting the first Files principal. */
export class VaultPrincipalRepository {
  constructor(private readonly database: pg.Pool) {}

  async withLockedCollections<T>(work: (client: pg.PoolClient, collections: CollectionOwnerRow[]) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const collections = (await client.query<CollectionOwnerRow>(
        'SELECT id::text,owner_user_id FROM collections FOR UPDATE',
      )).rows;
      const result = await work(client, collections);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async hasConflictingBundle(client: pg.PoolClient, collectionIds: string[], principalId: string): Promise<boolean> {
    const result = await client.query(
      'SELECT 1 FROM files_collection_key_bundles WHERE collection_id=ANY($1::uuid[]) AND principal_id<>$2 LIMIT 1',
      [collectionIds, principalId],
    );
    return Boolean(result.rowCount);
  }

  async transferOwnedCollections(client: pg.PoolClient, collectionIds: string[], previousPrincipalId: string, principalId: string): Promise<void> {
    await client.query(
      `UPDATE file_share_links links SET owner_user_id=$2
        WHERE links.owner_user_id=$3 AND (
          links.collection_id=ANY($1::uuid[])
          OR EXISTS(SELECT 1 FROM files WHERE files.id=links.file_id AND files.collection_id=ANY($1::uuid[]))
        )`,
      [collectionIds, principalId, previousPrincipalId],
    );
    await client.query(
      'UPDATE collections SET owner_user_id=$2,updated_at=NOW() WHERE id=ANY($1::uuid[])',
      [collectionIds, principalId],
    );
  }
}
