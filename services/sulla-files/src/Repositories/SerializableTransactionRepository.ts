// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** SQL that opens and closes one SERIALIZABLE receipt transaction with its local timeouts. */
export class SerializableTransactionRepository {
  async begin(client:pg.PoolClient):Promise<void> {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
  }

  async commit(client:pg.PoolClient):Promise<void> { await client.query('COMMIT') }

  async rollback(client:pg.PoolClient):Promise<void> { await client.query('ROLLBACK') }
}
