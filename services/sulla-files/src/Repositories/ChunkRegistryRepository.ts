// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Which chunk ids have a `chunks` row. Runs on the caller's (transaction) client. */
export class ChunkRegistryRepository {
  async registeredIds(client:Queryable, collectionId:string, ids:readonly string[]):Promise<Set<string>> {
    return new Set((await client.query('SELECT id FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, ids])).rows.map(row => String(row.id)));
  }
}
