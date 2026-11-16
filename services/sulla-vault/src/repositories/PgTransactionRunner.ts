// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** The one pool capability a transaction needs: hand out a client. */
export interface TransactionPool {
  connect(): Promise<pg.PoolClient>;
}

/** The statement that opens the transaction; read-only sources open with BEGIN READ ONLY. */
export type TransactionBegin = 'BEGIN' | 'BEGIN READ ONLY';

/**
 * One BEGIN … COMMIT unit on a pooled client, shared by every vault transaction helper.
 * The operation's own error always surfaces. If ROLLBACK itself fails, the connection may still
 * hold the open transaction (and any transaction-scoped advisory lock), so it is released with the
 * rollback error and the pool destroys it instead of handing it to the next caller.
 */
export class PgTransactionRunner {
  async run<T>(
    pool: TransactionPool, operation: (client: pg.PoolClient) => Promise<T>, begin: TransactionBegin = 'BEGIN',
  ): Promise<T> {
    const client = await pool.connect();
    let brokenConnection: Error | undefined;
    try {
      await client.query(begin);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        brokenConnection = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      client.release(brokenConnection);
    }
  }
}
