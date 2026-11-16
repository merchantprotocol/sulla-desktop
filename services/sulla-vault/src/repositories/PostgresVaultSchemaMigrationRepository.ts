// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';

/**
 * The statements the vault migrator runs on its one checked-out client: the
 * transaction, the cross-process advisory lock, the applied-migrations ledger
 * and the migration scripts themselves.
 */
export class PostgresVaultSchemaMigrationRepository {
  constructor(private readonly client: Queryable) {}

  async begin(): Promise<void> { await this.client.query('BEGIN'); }

  async lock(): Promise<void> { await this.client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-vault-migrations'))"); }

  async isApplied(version: string): Promise<boolean> {
    const done = await this.client.query('SELECT 1 FROM vault_schema_migrations WHERE version = $1', [version]);
    return Boolean(done.rowCount);
  }

  async runScript(sql: string): Promise<void> { await this.client.query(sql); }

  async recordApplied(version: string): Promise<void> {
    await this.client.query('INSERT INTO vault_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
  }

  async commit(): Promise<void> { await this.client.query('COMMIT'); }

  async rollback(): Promise<void> { await this.client.query('ROLLBACK'); }
}
