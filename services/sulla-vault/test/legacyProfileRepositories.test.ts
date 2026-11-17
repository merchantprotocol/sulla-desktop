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
});
