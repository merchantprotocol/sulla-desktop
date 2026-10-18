import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Pool } = pg;
export type Database = pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export async function connectDatabase(databaseUrl: string): Promise<Database> {
  const db = new Pool({ connectionString: databaseUrl, max: 10 });
  await db.query('SELECT 1');
  return db;
}

export async function migrate(db: Database): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  let directory: string | undefined;
  let files: string[] = [];
  for (const candidate of [resolve(here, '../migrations'), resolve(here, '../../migrations')]) {
    try {
      files = (await readdir(candidate)).filter(file => /^\d{3}_.+\.sql$/.test(file)).sort();
      if (files.length) { directory = candidate; break; }
    } catch { /* try the source-tree layout */ }
  }
  if (!directory) throw new Error('Could not find Accounts migrations');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-accounts-migrations'))");
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (version !== '001_accounts') {
        const done = await client.query('SELECT 1 FROM accounts.accounts_schema_migrations WHERE version = $1', [version]);
        if (done.rowCount) continue;
      }
      await client.query(await readFile(resolve(directory, file), 'utf8'));
      await client.query('INSERT INTO accounts.accounts_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}