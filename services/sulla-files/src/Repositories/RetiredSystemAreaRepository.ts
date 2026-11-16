// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface RetiredAreaBlockers { files:boolean; gc:boolean; versions:boolean }

/**
 * SQL for dropping a retired system collection. Probes before the transaction use the pool from
 * the constructor; everything that decides and deletes runs on the transaction's client.
 */
export class RetiredSystemAreaRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async findCollectionId(area:string):Promise<string | undefined> {
    const row = (await this.db.query('SELECT id FROM collections WHERE system_area=$1', [area])).rows[0];
    return row ? String(row.id) : undefined;
  }

  async pendingChunkGc(collectionId:string):Promise<number> {
    return Number((await this.db.query('SELECT count(*)::int n FROM file_chunk_gc WHERE collection_id=$1', [collectionId])).rows[0].n);
  }

  /** Stops new versions from referencing chunks while the collection is checked and dropped. */
  async lockVersions(client:pg.PoolClient):Promise<void> {
    await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
  }

  /** Row-locks the collection; false when it is gone or no longer this retired area. */
  async lockCollection(client:pg.PoolClient, collectionId:string, area:string):Promise<boolean> {
    return Boolean((await client.query('SELECT id FROM collections WHERE id=$1 AND system_area=$2 FOR UPDATE', [collectionId, area])).rows[0]);
  }

  /** What still keeps the collection: its files, pending chunk cleanup, versions elsewhere reading its chunks. */
  async blockers(client:pg.PoolClient, collectionId:string):Promise<RetiredAreaBlockers> {
    return (await client.query(`SELECT
          EXISTS(SELECT 1 FROM files WHERE collection_id=$1) files,
          EXISTS(SELECT 1 FROM file_chunk_gc WHERE collection_id=$1) gc,
          EXISTS(SELECT 1 FROM file_versions WHERE chunk_collection_id=$1) versions`, [collectionId])).rows[0];
  }

  async chunkIds(client:pg.PoolClient, collectionId:string):Promise<string[]> {
    return (await client.query('SELECT id FROM chunks WHERE collection_id=$1', [collectionId])).rows.map(chunk => String(chunk.id));
  }

  /** Deletes the rows that reference the collection without ON DELETE CASCADE, then the collection. */
  async deleteCollection(client:pg.PoolClient, collectionId:string, area:string):Promise<void> {
    await client.query('DELETE FROM journal WHERE collection_id=$1', [collectionId]);
    await client.query('DELETE FROM file_purge_tombstones WHERE collection_id=$1', [collectionId]);
    await client.query('DELETE FROM file_share_links WHERE collection_id=$1', [collectionId]);
    await client.query('DELETE FROM file_roots WHERE collection_id=$1', [collectionId]);
    await client.query('DELETE FROM files_legacy_file_map WHERE source_collection_id=$1 OR shadow_collection_id=$1', [collectionId]);
    await client.query('DELETE FROM files_legacy_collection_map WHERE source_collection_id=$1 OR shadow_collection_id=$1', [collectionId]);
    await client.query('DELETE FROM collections WHERE id=$1 AND system_area=$2', [collectionId, area]);
  }
}
