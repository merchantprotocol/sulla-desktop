// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 db/auth characterization: migrate() must run the same statements, in the same transaction, with the
// same advisory lock and skip rules as the frozen pre-refactor copy (Support/E9Legacy/db.legacy.ts), and leave
// the same schema behind on PGlite, idempotently.

import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import type { Database } from '../../../../../../services/sulla-vault/src/db';
import * as current from '../../../../../../services/sulla-vault/src/db';
import * as legacy from '../../Support/E9Legacy/db.legacy';

type Migrate = (db: Database) => Promise<void>;

/** A pg-shaped client over PGlite that records every statement. Multi-statement SQL goes through exec. */
class RecordingPgliteClient {
  readonly statements: string[] = [];
  released = 0;

  constructor(private readonly pglite: PGlite) {}

  async query(sql: string, values?: unknown[]) {
    this.statements.push(values ? `${ sql } -- ${ JSON.stringify(values) }` : sql);
    if (values) {
      const result = await this.pglite.query(sql, values) as { rows: unknown[]; affectedRows?: number };
      return { rows: result.rows, rowCount: result.rows.length > 0 ? result.rows.length : result.affectedRows ?? 0 };
    }
    const results = await this.pglite.exec(sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    const last = results.at(-1) as { rows: unknown[]; affectedRows?: number } | undefined;
    return { rows: last?.rows ?? [], rowCount: last ? (last.rows.length > 0 ? last.rows.length : last.affectedRows ?? 0) : 0 };
  }

  release(): void { this.released++; }

  asDatabase(): Database {
    return { connect: async() => this } as unknown as Database;
  }
}

class SchemaSnapshot {
  static async of(pglite: PGlite) {
    const tables = await pglite.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    const columns = await pglite.query<{ c: string }>("SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS c FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name");
    const indexes = await pglite.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname");
    const versions = await pglite.query<{ version: string }>('SELECT version FROM vault_schema_migrations ORDER BY version');
    return {
      tables:   tables.rows.map((row) => row.table_name),
      columns:  columns.rows.map((row) => row.c),
      indexes:  indexes.rows.map((row) => row.indexname),
      versions: versions.rows.map((row) => row.version),
    };
  }
}

class MigrationRun {
  readonly pglite = new PGlite();

  async twice(migrate: Migrate) {
    const first = new RecordingPgliteClient(this.pglite);
    await migrate(first.asDatabase());
    const afterFirst = await SchemaSnapshot.of(this.pglite);
    const second = new RecordingPgliteClient(this.pglite);
    await migrate(second.asDatabase());
    const afterSecond = await SchemaSnapshot.of(this.pglite);
    return { first: first.statements, firstReleased: first.released, second: second.statements, secondReleased: second.released, afterFirst, afterSecond };
  }
}

/** A scripted client: the Nth statement throws, everything else succeeds with a chosen rowCount. */
class FailingClient {
  readonly statements: string[] = [];
  released = 0;

  constructor(private readonly failAt: (sql: string, index: number) => unknown, private readonly appliedRowCount = 0) {}

  async query(sql: string, values?: unknown[]) {
    const index = this.statements.length;
    this.statements.push(values ? `${ sql } -- ${ JSON.stringify(values) }` : sql.slice(0, 60));
    const failure = this.failAt(sql, index);
    if (failure) throw failure;
    if (sql.startsWith('SELECT 1 FROM vault_schema_migrations')) return { rows: [], rowCount: this.appliedRowCount };
    return { rows: [], rowCount: 0 };
  }

  release(): void { this.released++; }

  asDatabase(): Database {
    return { connect: async() => this } as unknown as Database;
  }
}

const runs: MigrationRun[] = [];
afterAll(async() => { for (const run of runs) await run.pglite.close(); });

describe('E9 db.ts migrate matches the pre-refactor implementation', () => {
  it('applies every migration once, in order, in one locked transaction, and is idempotent', async() => { // risk: schema drift / double-applied migrations
    const legacyRun = new MigrationRun();
    const currentRun = new MigrationRun();
    runs.push(legacyRun, currentRun);
    const expected = await legacyRun.twice(legacy.migrate);
    const actual = await currentRun.twice(current.migrate);
    expect(actual).toEqual(expected);

    expect(actual.first[0]).toBe('BEGIN');
    expect(actual.first[1]).toBe("SELECT pg_advisory_xact_lock(hashtext('sulla-vault-migrations'))");
    expect(actual.first.at(-1)).toBe('COMMIT');
    expect(actual.firstReleased).toBe(1);
    expect(actual.afterFirst.versions[0]).toBe('001_initial');
    expect(actual.afterFirst.versions.length).toBeGreaterThan(10);
    expect(actual.afterFirst.tables).toContain('users');
    // Second run: same schema, only 001 re-runs, everything else is skipped.
    expect(actual.afterSecond).toEqual(actual.afterFirst);
    expect(actual.second.filter((sql) => sql.startsWith('INSERT INTO vault_schema_migrations'))).toEqual([
      'INSERT INTO vault_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING -- ["001_initial"]',
    ]);
  });

  it('rolls back, releases and rethrows the same error when a migration fails', async() => { // risk: half-applied schema
    const boom = Object.assign(new Error('syntax error at or near "x"'), { code: '42601' });
    const scenario = () => new FailingClient((sql, index) => (index === 5 ? boom : undefined));
    const legacyClient = scenario();
    const currentClient = scenario();
    const legacyError = await legacy.migrate(legacyClient.asDatabase()).catch((error: unknown) => error);
    const currentError = await current.migrate(currentClient.asDatabase()).catch((error: unknown) => error);
    expect(currentError).toBe(boom);
    expect(legacyError).toBe(boom);
    expect(currentClient.statements).toEqual(legacyClient.statements);
    expect(currentClient.statements.at(-1)).toBe('ROLLBACK');
    expect(currentClient.released).toBe(1);
    expect(legacyClient.released).toBe(1);
  });

  it('skips already-applied migrations except 001 exactly like legacy', async() => { // risk: re-running destructive migrations
    const legacyClient = new FailingClient(() => undefined, 1);
    const currentClient = new FailingClient(() => undefined, 1);
    await legacy.migrate(legacyClient.asDatabase());
    await current.migrate(currentClient.asDatabase());
    expect(currentClient.statements).toEqual(legacyClient.statements);
    expect(currentClient.statements.filter((sql) => sql.startsWith('INSERT INTO vault_schema_migrations'))).toHaveLength(1);
  });

  it('a failing BEGIN still issues ROLLBACK and releases, same as legacy', async() => { // risk: leaked pooled client
    const begin = new Error('Connection terminated unexpectedly');
    const legacyClient = new FailingClient((sql) => (sql === 'BEGIN' ? begin : undefined));
    const currentClient = new FailingClient((sql) => (sql === 'BEGIN' ? begin : undefined));
    await expect(legacy.migrate(legacyClient.asDatabase())).rejects.toBe(begin);
    await expect(current.migrate(currentClient.asDatabase())).rejects.toBe(begin);
    expect(currentClient.statements).toEqual(legacyClient.statements);
    expect(currentClient.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(currentClient.released).toBe(legacyClient.released);
  });
});
