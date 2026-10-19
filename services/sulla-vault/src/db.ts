import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { VaultConfig } from './config.js';

const { Pool } = pg;
export type Database = pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

/**
 * Postgres being down, restarting or still starting is expected (container
 * restarts, VM resume). Only connection-class failures are retried; real SQL
 * or migration errors still fail fast.
 */
export function isTransientDbError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; errors?: unknown[] } | null;
  if (!e || typeof e !== 'object') return false;
  const code = typeof e.code === 'string' ? e.code : '';
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;
  // 57P01-3 admin shutdown / crash / cannot connect now, 08xxx connection exceptions, 53300 too many connections.
  if (/^(57P0[123]|08|53300)/.test(code)) return true;
  if (Array.isArray(e.errors) && e.errors.length && e.errors.every(isTransientDbError)) return true;
  return typeof e.message === 'string' && /Connection terminated|connection.*(?:closed|ended)|timeout exceeded when trying to connect/i.test(e.message);
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Retry an operation until Postgres is reachable, with capped exponential backoff. */
export async function untilDatabaseReady<T>(label: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDbError(error)) throw error;
      const delay = Math.min(500 * 2 ** Math.min(attempt - 1, 4), 5000);
      const detail = (error as { code?: string; message?: string }).code ?? (error as Error).message;
      console.warn(`sulla-vault: waiting for Postgres during ${ label } (attempt ${ attempt }, ${ detail }); retrying in ${ delay }ms`);
      await sleep(delay);
    }
  }
}

/**
 * An idle pooled client can be terminated by the server (restart, 57P01).
 * Without a listener Node throws the 'error' event and kills the process; with
 * one, pg discards the dead client and the next query reconnects.
 */
function survivePoolErrors(pool: pg.Pool, label: string): pg.Pool {
  pool.on('error', (error) => {
    console.warn(`sulla-vault: ${ label } pool client error (will reconnect): ${ (error as { code?: string }).code ?? '' } ${ error.message }`);
  });
  return pool;
}

export async function ensureVaultDatabase(config: VaultConfig): Promise<void> {
  if (!config.adminDatabaseUrl) {
    return;
  }
  const admin = survivePoolErrors(new Pool({ connectionString: config.adminDatabaseUrl, max: 1 }), 'admin');
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
  await untilDatabaseReady('database setup', () => ensureVaultDatabase(config));
  const db = survivePoolErrors(new Pool({ connectionString: config.databaseUrl, max: 10 }), 'vault');
  await untilDatabaseReady('connect', () => db.query('SELECT 1'));
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
