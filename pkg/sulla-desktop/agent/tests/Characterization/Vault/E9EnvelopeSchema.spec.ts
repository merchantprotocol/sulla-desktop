// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 characterization: the Passwords sync v3 bookkeeping schema must stay
// character-identical and must produce the same tables, columns, constraints
// and indexes on a real Postgres (PGlite) as the verbatim legacy copy of
// browserEnvelope/schema.ts at ddbe28884. ensureSyncSchema keeps its
// once-per-process behaviour.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import { ensureSyncSchema, SYNC_SCHEMA_SQL } from '../../../../../../services/sulla-vault/src/browserEnvelope/schema';
import { ensureSyncSchema as legacyEnsureSyncSchema, SYNC_SCHEMA_SQL as LEGACY_SYNC_SCHEMA_SQL } from '../../Support/E9Legacy/schema.legacy';

const SYNC_TABLES = `('cloud_vault_sync_state','cloud_vault_sync_records')`;

/** PGlite with every vault migration applied (pgcrypto stripped, as the repository spec does). */
class MigratedDatabase {
  readonly pglite = new PGlite();

  static async create(): Promise<MigratedDatabase> {
    const database = new MigratedDatabase();
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()) {
      const sql = (await readFile(resolve(dir, file), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
      await database.pglite.exec(sql);
    }
    return database;
  }

  /** Multi-statement Queryable, the shape pg.Pool#query has for a parameterless string. */
  queryable(log: string[] = []) {
    return {
      query: async(sql: string) => {
        log.push(sql);
        await this.pglite.exec(sql);
        return { rows: [], rowCount: 0 };
      },
    };
  }

  async catalog() {
    const columns = await this.pglite.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
       FROM information_schema.columns WHERE table_name IN ${ SYNC_TABLES } ORDER BY table_name, ordinal_position`);
    const indexes = await this.pglite.query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN ${ SYNC_TABLES } ORDER BY tablename, indexname`);
    const constraints = await this.pglite.query(
      `SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid::regclass::text IN ${ SYNC_TABLES } ORDER BY 1, 2`);
    return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows };
  }

  close(): Promise<void> {
    return this.pglite.close();
  }
}

class RecordingQueryable {
  readonly calls: string[] = [];

  constructor(private readonly failWith: Error | null = null) {}

  async query(sql: string) {
    this.calls.push(sql);
    if (this.failWith) throw this.failWith;
    return { rows: [], rowCount: 0 };
  }
}

const databases: MigratedDatabase[] = [];
afterAll(async() => {
  for (const database of databases) await database.close();
});

describe.sequential('E9 browserEnvelope schema: equals legacy copy', () => {
  it('exports the character-identical schema SQL', () => {
    // risk: data integrity — any drift changes the sync tables Cloud anti-rollback relies on.
    expect(SYNC_SCHEMA_SQL).toBe(LEGACY_SYNC_SCHEMA_SQL);
  });

  it('a failed first apply leaves ensureSyncSchema retryable (legacy and current alike)', async() => {
    // risk: data integrity — a failed create must not be remembered as done.
    for (const ensure of [legacyEnsureSyncSchema, ensureSyncSchema]) {
      const failing = new RecordingQueryable(new Error('relation "users" does not exist'));
      await expect(ensure(failing as never)).rejects.toThrow('relation "users" does not exist');
      expect(failing.calls).toEqual([LEGACY_SYNC_SCHEMA_SQL]);
    }
  });

  it('creates the same tables, columns, constraints and indexes on Postgres', async() => {
    // risk: data integrity — schema application equivalence.
    const legacyDb = await MigratedDatabase.create();
    const currentDb = await MigratedDatabase.create();
    databases.push(legacyDb, currentDb);
    const legacyLog: string[] = [];
    const currentLog: string[] = [];

    await legacyEnsureSyncSchema(legacyDb.queryable(legacyLog) as never);
    await ensureSyncSchema(currentDb.queryable(currentLog) as never);

    expect(currentLog).toEqual(legacyLog);
    expect(currentLog).toEqual([LEGACY_SYNC_SCHEMA_SQL]);
    const legacyCatalog = await legacyDb.catalog();
    const currentCatalog = await currentDb.catalog();
    expect(currentCatalog).toEqual(legacyCatalog);
    expect(currentCatalog.columns.map(row => `${ (row as { table_name: string }).table_name }.${ (row as { column_name: string }).column_name }`)).toEqual([
      'cloud_vault_sync_records.owner_user_id', 'cloud_vault_sync_records.scope', 'cloud_vault_sync_records.record_id',
      'cloud_vault_sync_records.generation', 'cloud_vault_sync_records.deleted', 'cloud_vault_sync_records.record_mac',
      'cloud_vault_sync_records.local_revision', 'cloud_vault_sync_records.policy_review_pending', 'cloud_vault_sync_records.held_record',
      'cloud_vault_sync_state.owner_user_id', 'cloud_vault_sync_state.vault_id', 'cloud_vault_sync_state.epoch',
      'cloud_vault_sync_state.bundle_generation', 'cloud_vault_sync_state.head_seq', 'cloud_vault_sync_state.head_mac',
      'cloud_vault_sync_state.last_push_at', 'cloud_vault_sync_state.last_pull_at', 'cloud_vault_sync_state.last_error',
      'cloud_vault_sync_state.updated_at', 'cloud_vault_sync_state.bundle_sha',
    ]);
  });

  it('applies only once per process afterwards, even for a different database (legacy and current alike)', async() => {
    // risk: data integrity — pins the process-wide "ensured" flag (no re-apply per call).
    for (const ensure of [legacyEnsureSyncSchema, ensureSyncSchema]) {
      const later = new RecordingQueryable();
      await ensure(later as never);
      await ensure(later as never);
      expect(later.calls).toEqual([]);
    }
  });

  it('re-applying the schema SQL is idempotent and leaves the catalog unchanged', async() => {
    // risk: data integrity — startup re-runs must not fail or alter the tables.
    const database = await MigratedDatabase.create();
    databases.push(database);
    await database.pglite.exec(SYNC_SCHEMA_SQL);
    const first = await database.catalog();
    await database.pglite.exec(SYNC_SCHEMA_SQL);
    await database.pglite.exec(LEGACY_SYNC_SCHEMA_SQL);
    expect(await database.catalog()).toEqual(first);
    expect(first.constraints.length).toBeGreaterThan(0);
  });
});
