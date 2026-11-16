// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The sync runner's transaction helper: one pooled client per operation, via the shared PgTransactionRunner.

import type pg from 'pg';

import type { Database } from '../../../db.js';
import { PgTransactionRunner } from '../../../repositories/PgTransactionRunner.js';

export class PostgresSyncTransaction {
  constructor(private readonly transactions: PgTransactionRunner = new PgTransactionRunner()) {}

  /** A failed ROLLBACK keeps the original error and releases the client with the rollback error. */
  run<T>(db: Database, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.transactions.run(db, operation);
  }
}
