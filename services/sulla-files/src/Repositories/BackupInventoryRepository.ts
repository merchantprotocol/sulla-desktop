// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChunkRow, ChunkSizeRow } from '../backup/SchemaEvidence.js';
import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

/** Chunk inventory and key-recovery facts a coherent backup must prove before it is trusted. */
export class BackupInventoryRepository {
  async vaultPrincipalCount(client:Queryable):Promise<number> {
    return ((await client.query('SELECT count(DISTINCT owner_user_id)::int AS count FROM collections')).rows as { count:number }[])[0].count;
  }

  /** A collection still on a legacy key or compatibility path cannot be recovered from a backup alone. */
  async hasUnsupportedCollection(client:Queryable):Promise<boolean> {
    return Boolean((await client.query(
      `SELECT k.collection_id FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      WHERE k.key_origin<>'random' OR c.compatibility_state<>'native' LIMIT 1`,
    )).rowCount);
  }

  async hasCollectionWithoutRecoveryBundle(client:Queryable):Promise<boolean> {
    return Boolean((await client.query(
      `SELECT k.collection_id FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      LEFT JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id
       AND b.principal_id=c.owner_user_id AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
      WHERE b.collection_id IS NULL OR b.authority_registered_at IS NULL LIMIT 1`,
    )).rowCount);
  }

  /** Some version's manifest names a chunk that has no chunks row. */
  async hasUnresolvedChunkReference(client:Queryable):Promise<boolean> {
    return Boolean((await client.query(
      `SELECT v.id FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
     CROSS JOIN LATERAL jsonb_array_elements_text(m.chunk_ids) item(chunk_id)
     LEFT JOIN chunks c ON c.collection_id=v.chunk_collection_id AND c.id=item.chunk_id
     WHERE c.id IS NULL LIMIT 1`,
    )).rowCount);
  }

  async chunkInventory(client:Queryable):Promise<Omit<ChunkRow, 'backupPath'>[]> {
    return (await client.query(
      'SELECT collection_id::text,id,size,stored_size,location,refcount::text FROM chunks ORDER BY collection_id,id',
    )).rows as Omit<ChunkRow, 'backupPath'>[];
  }

  async chunkSizes(client:Queryable):Promise<ChunkSizeRow[]> {
    return (await client.query('SELECT collection_id::text,id,stored_size FROM chunks ORDER BY collection_id,id')).rows as ChunkSizeRow[];
  }
}
