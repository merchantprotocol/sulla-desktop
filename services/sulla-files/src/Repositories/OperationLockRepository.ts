// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Transaction-scoped advisory locks used by receipt and batch operations. */
export class OperationLockRepository {
  async lock(client:Queryable, key:string):Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  }

  /** Serializes writers of one collection's stored namespace. */
  lockNamespace(client:Queryable, collectionId:string):Promise<void> {
    return this.lock(client, 'stored-namespace:' + collectionId);
  }
}
