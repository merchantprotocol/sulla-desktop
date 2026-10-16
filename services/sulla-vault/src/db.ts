import { readdir, readFile } from 'node:fs/promises';
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
  let dir: string | undefined;
  let files: string[] = [];
  for (const candidate of [resolve(here, '../migrations'), resolve(here, '../../migrations')]) {
    try {
      files = (await readdir(candidate)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
      if (files.length) {
        dir = candidate;
        break;
      }
    } catch {
      // Try the source-tree path after the container path.
    }
  }
  if (!dir) {
    throw new Error('Could not find vault migrations');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-vault-migrations'))");
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      // 001 creates vault_schema_migrations itself, so it always runs (it is idempotent).
      if (version !== '001_initial') {
        const done = await client.query('SELECT 1 FROM vault_schema_migrations WHERE version = $1', [version]);
        if (done.rowCount) continue;
      }
      await client.query(await readFile(resolve(dir, file), 'utf8'));
      await client.query('INSERT INTO vault_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
