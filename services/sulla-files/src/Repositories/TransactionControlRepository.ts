// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Owns the SQL control statements that define a transaction boundary. */
export class TransactionControlRepository {
  begin(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('BEGIN') }
  commit(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('COMMIT') }
  rollback(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('ROLLBACK') }
}
