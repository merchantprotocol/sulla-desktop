// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Queryable } from '../db.js';

const SAFE_DATABASE_IDENTIFIER = /^sulla_vault_[a-f0-9]{48}$/;

/** Admin-connection SQL boundary; only canonical hashed identifiers are interpolated. */
export class PostgresProfileDatabaseRepository {
  constructor(private readonly admin: Queryable) {}

  async createIfMissing(dbIdentifier: string): Promise<void> {
    if (!SAFE_DATABASE_IDENTIFIER.test(dbIdentifier)) throw new Error('Invalid profile database identifier');
    const exists = await this.admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbIdentifier]);
    if (exists.rowCount !== 0) return;
    // PostgreSQL parameters cannot bind identifiers; strict lowercase hex whitelist makes quoting safe.
    await this.admin.query(`CREATE DATABASE "${dbIdentifier}"`);
  }
}
