// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// risk: data integrity — migration reads must be allowlisted, transactionally locked, and byte-stable.
import { describe, expect, it } from 'vitest';
import { LegacyProfileHashRepository } from '../src/repositories/LegacyProfileHashRepository.js';
import { PostgresLegacyProfileSourceRepository } from '../src/repositories/PostgresLegacyProfileSourceRepository.js';
import { PostgresLegacyProfileDestinationRepository } from '../src/repositories/PostgresLegacyProfileDestinationRepository.js';

class FakePgClient {
  statements: { sql: string; params?: unknown[] }[] = [];
  released = false;
  async query(sql: string, params?: unknown[]) {
    this.statements.push({ sql, params });
    if (sql.includes('information_schema.tables')) return { rows: [{ table_name: 'users' }, { table_name: 'vault_profile_catalog' }, { table_name: 'vault_profile_active' }], rowCount: 3 };
    if (sql.includes('pg_sequences')) return { rows: [{ sequencename: 'items_change_seq_seq' }], rowCount: 1 };
    if (sql.includes('SELECT * FROM')) return { rows: [{ id: 'secret-row-value', payload: Buffer.from([0, 255]) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  release() { this.released = true; }
}
class FakePgPool {
  client = new FakePgClient();
  async connect() { return this.client as never; }
  async query(sql: string, params?: unknown[]) { return this.client.query(sql, params); }
}

describe('legacy profile repository SQL boundaries', () => {
  it('excludes profile metadata, locks enumerated tables in the transaction, and parameterizes row content', async () => {
    const pool = new FakePgPool();
    const source = new PostgresLegacyProfileSourceRepository(pool as never);
    await source.withExclusiveReadLock(async () => {
      expect(await source.tables()).toEqual(['users']);
      const rows = await source.rows('users');
      expect(rows[0].payload).toEqual(Buffer.from([0, 255]));
      await expect(source.rows('users; DROP TABLE users')).rejects.toThrow(/not enumerated/);
    });
    const statements = pool.client.statements;
    expect(statements.map(item => item.sql)).toContain('BEGIN');
    expect(statements.map(item => item.sql)).toContain('COMMIT');
    const begin = statements.findIndex(item => item.sql === 'BEGIN');
    const commit = statements.findIndex(item => item.sql === 'COMMIT');
    expect(statements.slice(begin + 1, commit).some(item => item.sql.includes('LOCK TABLE public."users" IN EXCLUSIVE MODE'))).toBe(true);
    expect(statements.every(item => !item.sql.includes('secret-row-value'))).toBe(true);
    expect(pool.client.released).toBe(true);
  });
});

describe('legacy profile canonical hash', () => {
  it('is stable across row order and changes when bytea changes', () => {
    const hash = new LegacyProfileHashRepository();
    const first = [{ id: 'b', value: Buffer.from([0, 255]) }, { id: 'a', value: Buffer.from([1]) }];
    expect(hash.digest(first)).toBe(hash.digest([...first].reverse()));
    expect(hash.digest(first)).not.toBe(hash.digest([{ ...first[0], value: Buffer.from([0, 254]) }, first[1]]));
  });
});


describe('legacy profile destination SQL boundaries', () => {
  it('binds copied row data and rejects unvalidated identifiers before SQL', async () => {
    const pool = new FakePgPool();
    const destination = new PostgresLegacyProfileDestinationRepository(() => pool as never, pool as never, '/unused');
    await destination.withTransaction('sulla_vault_' + 'a'.repeat(48), async writer => {
      await writer.copy('items', [{ id: 'sensitive-row-value', payload: Buffer.from([0, 255]) }]);
      await expect(writer.copy('items; DROP TABLE users', [{ id: 'x' }])).rejects.toThrow(/Invalid SQL table/);
    });
    const insert = pool.client.statements.find(item => item.sql.startsWith('INSERT'));
    expect(insert?.sql).toContain('INSERT INTO public."items"');
    expect(insert?.sql).not.toContain('sensitive-row-value');
    expect(insert?.params).toEqual(['sensitive-row-value', Buffer.from([0, 255])]);
    expect(pool.client.statements.every(item => !item.sql.includes('sensitive-row-value'))).toBe(true);
    await expect(destination.drop('bad"; DROP DATABASE')).rejects.toThrow(/Invalid profile database/);
  });

  // risk: data accuracy — user triggers must not rewrite copied change_seq/updated_at, and must be back on before COMMIT.
  it('disables user triggers and restores sequences inside the same BEGIN/COMMIT, re-enabling before COMMIT', async () => {
    const pool = new FakePgPool();
    const destination = new PostgresLegacyProfileDestinationRepository(() => pool as never, pool as never, '/unused');
    await destination.withTransaction('sulla_vault_' + 'a'.repeat(48), async writer => {
      await writer.prepare(['users'], [{ name: 'items_change_seq_seq', lastValue: '42', isCalled: true }]);
      await writer.copy('users', [{ id: 'row-1' }]);
    });
    const sql = pool.client.statements.map(item => item.sql);
    const begin = sql.indexOf('BEGIN');
    const commit = sql.indexOf('COMMIT');
    const disable = sql.indexOf('ALTER TABLE public."users" DISABLE TRIGGER USER');
    const enable = sql.indexOf('ALTER TABLE public."users" ENABLE TRIGGER USER');
    expect(disable).toBeGreaterThan(begin);
    expect(enable).toBeGreaterThan(disable);
    expect(enable).toBeLessThan(commit);
    const setval = pool.client.statements.find(item => item.sql.startsWith('SELECT setval'));
    expect(setval?.params).toEqual(['public."items_change_seq_seq"', '42', true]);
  });

  // risk: data accuracy — a sequence set mismatch must fail before any write reaches the profile database.
  it('refuses a legacy sequence set that differs from the profile database before writing', async () => {
    const pool = new FakePgPool();
    const destination = new PostgresLegacyProfileDestinationRepository(() => pool as never, pool as never, '/unused');
    await expect(destination.withTransaction('sulla_vault_' + 'a'.repeat(48), writer =>
      writer.prepare(['users'], [{ name: 'other_seq', lastValue: '1', isCalled: false }]))).rejects.toThrow(/sequence sets differ/);
    const sql = pool.client.statements.map(item => item.sql);
    expect(sql.some(item => item.includes('TRUNCATE') || item.includes('DISABLE TRIGGER') || item.includes('setval'))).toBe(false);
  });

  // risk: data integrity — sequence names are interpolated only after validation.
  it('rejects invalid sequence identifiers and values before SQL', async () => {
    const pool = new FakePgPool();
    const destination = new PostgresLegacyProfileDestinationRepository(() => pool as never, pool as never, '/unused');
    await expect(destination.withTransaction('sulla_vault_' + 'a'.repeat(48), writer =>
      writer.prepare(['users'], [{ name: 'x"; DROP TABLE users', lastValue: '1', isCalled: false }]))).rejects.toThrow(/Invalid sequence identifier/);
    await expect(destination.withTransaction('sulla_vault_' + 'a'.repeat(48), writer =>
      writer.prepare(['users'], [{ name: 'items_change_seq_seq', lastValue: '1; DROP', isCalled: false }]))).rejects.toThrow(/Invalid sequence value/);
  });
});
