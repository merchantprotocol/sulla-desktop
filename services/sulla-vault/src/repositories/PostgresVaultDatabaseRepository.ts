// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';

/**
 * Connection-level statements on one pool: the admin-side check/creation of the
 * sulla_vault database and the vault pool's connectivity probe.
 */
export class PostgresVaultDatabaseRepository {
  constructor(private readonly pool: Queryable) {}

  /** True only when pg_database reports zero rows for sulla_vault (rowCount === 0). */
  async isVaultDatabaseMissing(): Promise<boolean> {
    const existing = await this.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', ['sulla_vault']);
    return existing.rowCount === 0;
  }

  async createVaultDatabase(): Promise<void> {
    await this.pool.query('CREATE DATABASE sulla_vault');
  }

  /** Connectivity probe; throws while Postgres is unreachable. */
  async ping(): Promise<unknown> {
    return this.pool.query('SELECT 1');
  }
}
