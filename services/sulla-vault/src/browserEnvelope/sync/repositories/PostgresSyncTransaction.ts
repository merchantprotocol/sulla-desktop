// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The runner's BEGIN/COMMIT/ROLLBACK helper (pure move): one pooled client per operation.

import type pg from 'pg';

import type { Database } from '../../../db.js';

export class PostgresSyncTransaction {
  async run<T>(db: Database, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
