// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Pool } = pg;
export type Database = pg.Pool;

export async function connectDatabase(databaseUrl: string): Promise<Database> {
  const db = new Pool({ connectionString: databaseUrl, max: 10 });
  await db.query('SELECT 1');
  return db;
}

export async function migrate(db: Database): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, 'migrations'), resolve(here, '../src/migrations')];
  let directory: string | undefined;
  let files: string[] = [];
  for (const candidate of candidates) {
    try {
      files = (await readdir(candidate)).filter(file => /^\d{3}_.+\.sql$/.test(file)).sort();
      if (files.length) { directory = candidate; break; }
    } catch { /* try the source-tree location */ }
  }
  if (!directory) throw new Error('Could not find Console migrations');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-console-migrations'))");
    // Create the ledger first: a failed lookup would abort the whole transaction on a fresh database.
    await client.query('CREATE SCHEMA IF NOT EXISTS sulla_console');
    await client.query('CREATE TABLE IF NOT EXISTS sulla_console.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const applied = await client.query('SELECT 1 FROM sulla_console.schema_migrations WHERE version=$1', [version]);
      if (applied.rowCount) continue;
      await client.query(await readFile(resolve(directory, file), 'utf8'));
      await client.query('INSERT INTO sulla_console.schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
