// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';

import { migrationsRegistry } from '../../database/migrations';

/** A disposable schema which exercises the same ordered migration registry as Desktop. */
export class TestDatabase {
  readonly schema = `spec_${ randomUUID().replaceAll('-', '') }`;
  private admin: Pool;
  private pool: Pool | null = null;

  constructor(readonly url = process.env.SULLA_TEST_DATABASE_URL ?? '') {
    this.admin = new Pool({ connectionString: url });
  }

  static available(): boolean { return Boolean(process.env.SULLA_TEST_DATABASE_URL) }

  async initialize(): Promise<void> {
    if (!this.url) throw new Error('SULLA_TEST_DATABASE_URL is required for database characterization specs');
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new Pool({ connectionString: this.url, options: `-csearch_path=${ this.schema },public` });
    await this.applyMigrations();
  }

  async applyMigrations(): Promise<void> {
    if (!this.pool) throw new Error('TestDatabase is not initialized');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sulla_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL, executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    const executed = new Set((await this.pool.query<{ name: string }>('SELECT name FROM sulla_migrations')).rows.map(row => row.name));
    for (const migration of migrationsRegistry) {
      if (executed.has(migration.name)) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if (typeof migration.up === 'function') await migration.up(client as PoolClient);
        else await client.query(migration.up);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release() }
      await this.pool.query('INSERT INTO sulla_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [migration.name]);
    }
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    if (!this.pool) throw new Error('TestDatabase is not initialized');
    return (await this.pool.query<T>(sql, values)).rows;
  }

  /** URL used by the real PostgresClient initialize path, isolated to this schema. */
  appUrl(): string {
    const url = new URL(this.url);
    url.searchParams.set('options', `-csearch_path=${ this.schema },public`);
    return url.toString();
  }

  async dispose(): Promise<void> {
    await this.pool?.end();
    await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`);
    await this.admin.end();
  }
}
