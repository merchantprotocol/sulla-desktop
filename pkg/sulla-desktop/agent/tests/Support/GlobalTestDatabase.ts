// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Pool, type PoolClient } from 'pg';

import { migrationsRegistry } from '../../database/migrations';

class GlobalTestDatabase {
  private pool: Pool | null = null;
  private schema: string | null = null;

  constructor(private readonly url = process.env.SULLA_TEST_DATABASE_URL ?? '') {}

  async setup(): Promise<void> {
    if (!this.url) return;
    const setupStarted = performance.now();
    process.stdout.write('::warning file=pkg/sulla-desktop/agent/tests/Support/GlobalTestDatabase.ts,title=Global database setup::Started Postgres schema and migrations.\n');
    this.schema = `spec_worker_${ randomUUID().replaceAll('-', '') }`;
    this.pool = new Pool({ connectionString: this.url, options: `-csearch_path=${ this.schema },public` });
    await this.pool.query(`CREATE SCHEMA "${ this.schema }"`);
    await this.pool.query('CREATE TABLE sulla_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL, executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    process.stdout.write(`::warning file=pkg/sulla-desktop/agent/tests/Support/GlobalTestDatabase.ts,title=Global database setup::Schema and migration table ready after ${(performance.now() - setupStarted).toFixed(0)}ms; applying ${migrationsRegistry.length} migrations.\n`);
    for (const migration of migrationsRegistry) {
      const migrationStarted = performance.now();
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if (typeof migration.up === 'function') await migration.up(client as PoolClient);
        else await client.query(migration.up);
        await client.query('INSERT INTO sulla_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release() }
      const migrationDuration = performance.now() - migrationStarted;
      if (migrationDuration >= 250) process.stdout.write(`::warning file=pkg/sulla-desktop/agent/tests/Support/GlobalTestDatabase.ts,title=Slow Postgres migration::${migration.name} took ${migrationDuration.toFixed(0)}ms.\n`);
    }
    process.stdout.write(`::warning file=pkg/sulla-desktop/agent/tests/Support/GlobalTestDatabase.ts,title=Global database setup duration::${migrationsRegistry.length} migrations finished in ${(performance.now() - setupStarted).toFixed(0)}ms.\n`);
    process.env.SULLA_TEST_SCHEMA = this.schema;
  }

  async teardown(): Promise<void> {
    if (!this.pool || !this.schema) return;
    await this.pool.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`);
    await this.pool.end();
  }
}

const database = new GlobalTestDatabase();

export async function setup(): Promise<void> { await database.setup() }
export async function teardown(): Promise<void> { await database.teardown() }
