import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { VaultConfig } from './config.js';

const { Pool } = pg;
export type Database = pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export async function ensureVaultDatabase(config: VaultConfig): Promise<void> {
  if (!config.adminDatabaseUrl) {
    return;
  }
  const admin = new Pool({ connectionString: config.adminDatabaseUrl, max: 1 });
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['sulla_vault']);
    if (existing.rowCount === 0) {
      await admin.query('CREATE DATABASE sulla_vault');
    }
  } finally {
    await admin.end();
  }
}

export async function connectDatabase(config: VaultConfig): Promise<Database> {
  await ensureVaultDatabase(config);
  const db = new Pool({ connectionString: config.databaseUrl, max: 10 });
  await db.query('SELECT 1');
  return db;
}

export async function migrate(db: Database): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../migrations/001_initial.sql'), resolve(here, '../../migrations/001_initial.sql')];
  let sql: string | undefined;
  for (const candidate of candidates) {
    try {
      sql = await readFile(candidate, 'utf8');
      break;
    } catch {
      // Try the source-tree path after the container path.
    }
  }
  if (!sql) {
    throw new Error('Could not find migration 001_initial.sql');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-vault-migrations'))");
    await client.query(sql);
    await client.query("INSERT INTO vault_schema_migrations(version) VALUES ('001_initial') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
