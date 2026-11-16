// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

export interface ProbeChunkRow { id:string; size:number }

/** Stored chunks of one collection, read inside the first-unlock transaction to identify its legacy content key. */
export class LegacyKeyProbeRepository {
  async sampleChunks(client:Queryable, collectionId:string, limit:number):Promise<ProbeChunkRow[]> {
    return (await client.query('SELECT id,size FROM chunks WHERE collection_id=$1 ORDER BY id LIMIT $2', [collectionId, limit]))
      .rows.map(row => ({ id: String(row.id), size: Number(row.size) }));
  }
}
