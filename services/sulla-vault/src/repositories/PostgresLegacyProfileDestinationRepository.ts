// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type pg from 'pg';
import type { Database, Queryable } from '../db.js';
import { VaultMigrator } from '../database/VaultMigrator.js';
import { PgTransactionRunner, type TransactionPool } from './PgTransactionRunner.js';

const DATABASE_IDENTIFIER = /^sulla_vault_[a-f0-9]{48}$/;
const TABLE_IDENTIFIER = /^[_a-zA-Z][a-zA-Z0-9_]{0,62}$/;

/** Per-profile database operations. Pools, admin access, and migration path are injected. */
export class PostgresLegacyProfileDestinationRepository {
  constructor(
    private readonly databaseFor: (identifier: string) => Database,
    private readonly admin: Queryable,
    private readonly migrationsDirectory: string,
    private readonly transactions = new PgTransactionRunner(),
  ) {}

  async assertFresh(dbIdentifier: string): Promise<void> {
    this.assertDatabaseIdentifier(dbIdentifier);
    const exists = await this.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbIdentifier]);
    if (!exists.rowCount) return; // Provisioning creates the new DB after this preflight.
    const result = await this.transactions.run(this.database(dbIdentifier) as unknown as TransactionPool, client =>
      client.query("SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' LIMIT 1"));
    if (result.rowCount) throw new Error('Profile database is not fresh');
  }

  async prepareSchema(dbIdentifier: string): Promise<void> {
    await new VaultMigrator(this.migrationsDirectory).migrate(this.database(dbIdentifier));
  }

  async withTransaction<T>(dbIdentifier: string, operation: (writer: { copy(table: string, rows: readonly Record<string, unknown>[]): Promise<void> }) => Promise<T>): Promise<T> {
    return this.transactions.run(this.database(dbIdentifier) as unknown as TransactionPool, async client => operation({
      copy: async (table, rows) => this.copyWith(client, table, rows),
    }));
  }

  async rows(dbIdentifier: string, table: string): Promise<readonly Record<string, unknown>[]> {
    this.assertTable(table);
    return (await this.database(dbIdentifier).query(`SELECT * FROM public.\"${table}\"`)).rows;
  }

  async drop(dbIdentifier: string): Promise<void> {
    this.assertDatabaseIdentifier(dbIdentifier);
    await this.admin.query(`DROP DATABASE IF EXISTS \"${dbIdentifier}\"`);
  }

  private async copyWith(client: pg.PoolClient, table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
    this.assertTable(table);
    if (!rows.length) return;
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
    if (!columns.length || columns.some(column => !TABLE_IDENTIFIER.test(column))) throw new Error('Invalid row column');
    const values: unknown[] = [];
    const tuples = rows.map(row => `(${columns.map(column => { values.push(row[column] ?? null); return `$${values.length}`; }).join(',')})`);
    await client.query(`INSERT INTO public.\"${table}\" (${columns.map(column => `\"${column}\"`).join(',')}) VALUES ${tuples.join(',')}`, values);
  }

  private database(identifier: string): Database { this.assertDatabaseIdentifier(identifier); return this.databaseFor(identifier); }
  private assertDatabaseIdentifier(identifier: string): void { if (!DATABASE_IDENTIFIER.test(identifier)) throw new Error('Invalid profile database identifier'); }
  private assertTable(identifier: string): void { if (!TABLE_IDENTIFIER.test(identifier)) throw new Error('Invalid SQL table identifier'); }
}
