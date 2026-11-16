// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

export interface MissingChunkReference { collection_id:string; id:string; total_size:string | number; position:number; chunk_count:number }
export interface RestoredChunkRow { collectionId:string; id:string; size:number; storedSize:number; location:string; refcount:number }

/** Finds manifest-referenced chunks whose `chunks` row is missing and restores verified rows (migration 066 repair). */
export class ChunkMetadataRepairRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Every (collection, chunk, position) a version's manifest names with no `chunks` row. */
  async missingReferences():Promise<MissingChunkReference[]> {
    return (await this.db.query(`SELECT DISTINCT v.chunk_collection_id::text collection_id,x.id,
        m.total_size, x.ordinality::int position, cardinality(ARRAY(SELECT jsonb_array_elements_text(m.chunk_ids)))::int chunk_count
      FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
      CROSS JOIN LATERAL jsonb_array_elements_text(m.chunk_ids) WITH ORDINALITY x(id,ordinality)
      LEFT JOIN chunks c ON c.collection_id=v.chunk_collection_id AND c.id=x.id
      WHERE c.id IS NULL AND m.chunk_ids IS NOT NULL ORDER BY 1,2`)).rows;
  }

  /** Blocks version inserts/updates until the repair transaction ends. */
  async lockVersions(client:Queryable):Promise<void> {
    await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
  }

  async chunkExists(client:Queryable, collectionId:string, id:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId, id])).rowCount);
  }

  /** Distinct versions whose manifest names the chunk: the refcount a restored row starts with. */
  async versionReferenceCount(client:Queryable, collectionId:string, id:string):Promise<number> {
    return Number((await client.query(`SELECT COUNT(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
            WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [collectionId, id])).rows[0]?.refs ?? 0);
  }

  /** Inserts the restored row; false when one appeared concurrently. */
  async insertRestored(client:Queryable, row:RestoredChunkRow):Promise<boolean> {
    return Boolean((await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(collection_id,id) DO NOTHING RETURNING id`,
    [row.collectionId, row.id, row.size, row.storedSize, row.location, row.refcount])).rowCount);
  }
}
