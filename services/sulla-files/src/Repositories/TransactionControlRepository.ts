// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Owns the SQL control statements that define a transaction boundary. */
export class FilesTransactionAbortedError extends Error {
  readonly code = 'FILES_TRANSACTION_ABORTED';

  constructor() {
    super('Files transaction was rolled back by PostgreSQL instead of committed');
    this.name = 'FilesTransactionAbortedError';
  }
}

export class TransactionControlRepository {
  begin(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('BEGIN') }
  async commit(client:pg.PoolClient):Promise<pg.QueryResult> {
    const result = await client.query('COMMIT');
    if (result.command === 'ROLLBACK') throw new FilesTransactionAbortedError();
    return result;
  }
  rollback(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('ROLLBACK') }
  /** Derived, reconstructible state only: acknowledge the commit before its WAL flush. */
  useAsynchronousCommit(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('SET LOCAL synchronous_commit = off') }
}
