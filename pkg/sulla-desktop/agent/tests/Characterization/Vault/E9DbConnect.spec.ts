// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 db/auth characterization: ensureVaultDatabase/connectDatabase must open the same pools with the same
// options, register the same error listener and issue the same statements in the same order as the frozen
// pre-refactor copy (Support/E9Legacy/db.legacy.ts). `pg` is replaced by a recording fake for both.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recorder = vi.hoisted(() => {
  class Recorder {
    log: unknown[][] = [];
    pools: unknown[] = [];
    handlers: Array<(error: unknown) => void> = [];
    databaseExists = true;
    failures: Array<{ sql: string; error: unknown }> = [];

    reset(): void {
      this.log = [];
      this.pools = [];
      this.handlers = [];
      this.databaseExists = true;
      this.failures = [];
    }
  }
  const state = new Recorder();

  class FakePool {
    readonly id: number;

    constructor(readonly options: Record<string, unknown>) {
      this.id = state.pools.length;
      state.pools.push(this);
      state.log.push(['new Pool', this.id, { ...options }]);
    }

    on(event: string, handler: (error: unknown) => void): this {
      state.log.push(['on', this.id, event, typeof handler]);
      state.handlers.push(handler);
      return this;
    }

    async query(sql: string, params?: unknown[]) {
      state.log.push(['query', this.id, sql, params]);
      const index = state.failures.findIndex((failure) => failure.sql === sql);
      if (index >= 0) {
        const [failure] = state.failures.splice(index, 1);
        throw failure.error;
      }
      if (sql.startsWith('SELECT 1 FROM pg_database')) return { rowCount: state.databaseExists ? 1 : 0, rows: state.databaseExists ? [{ '?column?': 1 }] : [] };
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    }

    async end(): Promise<void> {
      state.log.push(['end', this.id]);
    }
  }

  return { state, FakePool };
});

vi.mock('pg', () => ({ default: { Pool: recorder.FakePool } }));

import type { VaultConfig } from '../../../../../../services/sulla-vault/src/config';
import * as current from '../../../../../../services/sulla-vault/src/db';
import * as legacy from '../../Support/E9Legacy/db.legacy';

type Implementation = Pick<typeof legacy, 'connectDatabase' | 'ensureVaultDatabase'>;

class ConnectScenario {
  constructor(
    private readonly config: Partial<VaultConfig>,
    private readonly setup: (state: typeof recorder.state) => void = () => {},
  ) {}

  async run(implementation: Implementation, action: 'connect' | 'ensure') {
    recorder.state.reset();
    this.setup(recorder.state);
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)); });
    const config = { databaseUrl: 'postgres://vault:pw@postgres:5432/sulla_vault', ...this.config } as VaultConfig;
    const promise = action === 'connect' ? implementation.connectDatabase(config) : implementation.ensureVaultDatabase(config);
    const settled = promise.then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled as { value?: unknown; error?: unknown };
    const returnedPoolIndex = outcome.value === undefined ? undefined : recorder.state.pools.indexOf(outcome.value);
    spy.mockRestore();
    return { log: recorder.state.log, warnings, error: outcome.error, valueIsUndefined: outcome.value === undefined, returnedPoolIndex };
  }

  async compare(action: 'connect' | 'ensure') {
    const expected = await this.run(legacy, action);
    const actual = await this.run(current, action);
    expect(actual).toEqual(expected);
    return actual;
  }
}

describe('E9 db.ts connection setup matches the pre-refactor implementation', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('ensureVaultDatabase is a no-op without an admin URL', async() => { // risk: touching a database it does not own
    const result = await new ConnectScenario({}).compare('ensure');
    expect(result.log).toEqual([]);
    expect(result.valueIsUndefined).toBe(true);
  });

  it('ensureVaultDatabase leaves an existing sulla_vault database alone', async() => { // risk: data loss on startup
    const result = await new ConnectScenario({ adminDatabaseUrl: 'postgres://admin@postgres/postgres' }).compare('ensure');
    expect(result.log).toEqual([
      ['new Pool', 0, { connectionString: 'postgres://admin@postgres/postgres', max: 1 }],
      ['on', 0, 'error', 'function'],
      ['query', 0, 'SELECT 1 FROM pg_database WHERE datname = $1', ['sulla_vault']],
      ['end', 0],
    ]);
  });

  it('ensureVaultDatabase creates sulla_vault when missing', async() => { // risk: first-boot failure
    const result = await new ConnectScenario({ adminDatabaseUrl: 'postgres://admin@postgres/postgres' }, (state) => { state.databaseExists = false; }).compare('ensure');
    expect(result.log.filter((entry) => entry[0] === 'query').map((entry) => entry[2])).toEqual([
      'SELECT 1 FROM pg_database WHERE datname = $1',
      'CREATE DATABASE sulla_vault',
    ]);
    expect(result.log.at(-1)).toEqual(['end', 0]);
  });

  it('ensureVaultDatabase still ends the admin pool and rethrows when a query fails', async() => { // risk: leaked admin connection
    const failure = Object.assign(new Error('permission denied to create database'), { code: '42501' });
    const result = await new ConnectScenario({ adminDatabaseUrl: 'postgres://admin@postgres/postgres' }, (state) => {
      state.databaseExists = false;
      state.failures.push({ sql: 'CREATE DATABASE sulla_vault', error: failure });
    }).compare('ensure');
    expect(result.error).toBe(failure);
    expect(result.log.at(-1)).toEqual(['end', 0]);
  });

  it('connectDatabase opens the vault pool with the same options and probes it', async() => { // risk: pool starvation / startup hang
    const result = await new ConnectScenario({ adminDatabaseUrl: 'postgres://admin@postgres/postgres' }).compare('connect');
    expect(result.log).toEqual([
      ['new Pool', 0, { connectionString: 'postgres://admin@postgres/postgres', max: 1 }],
      ['on', 0, 'error', 'function'],
      ['query', 0, 'SELECT 1 FROM pg_database WHERE datname = $1', ['sulla_vault']],
      ['end', 0],
      ['new Pool', 1, { connectionString: 'postgres://vault:pw@postgres:5432/sulla_vault', max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }],
      ['on', 1, 'error', 'function'],
      ['query', 1, 'SELECT 1', undefined],
    ]);
    expect(result.returnedPoolIndex).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('connectDatabase retries transient admin and probe failures the same way', async() => { // risk: crash loop while Postgres restarts
    const result = await new ConnectScenario({ adminDatabaseUrl: 'postgres://admin@postgres/postgres' }, (state) => {
      state.failures.push({ sql: 'SELECT 1 FROM pg_database WHERE datname = $1', error: Object.assign(new Error('the database system is starting up'), { code: '57P03' }) });
      state.failures.push({ sql: 'SELECT 1', error: new Error('Connection terminated unexpectedly') });
    }).compare('connect');
    expect(result.log.filter((entry) => entry[0] === 'new Pool')).toHaveLength(3);
    expect(result.returnedPoolIndex).toBe(2);
    expect(result.warnings).toEqual([
      'sulla-vault: waiting for Postgres during database setup (attempt 1, 57P03 the database system is starting up); retrying every 0.5s',
      'sulla-vault: waiting for Postgres during connect (attempt 1, Connection terminated unexpectedly); retrying every 0.5s',
    ]);
  });

  it('connectDatabase without an admin URL opens only the vault pool and rethrows real SQL errors', async() => { // risk: masking a broken database
    const fatal = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    const result = await new ConnectScenario({}, (state) => { state.failures.push({ sql: 'SELECT 1', error: fatal }); }).compare('connect');
    expect(result.error).toBe(fatal);
    expect(result.log.filter((entry) => entry[0] === 'new Pool')).toHaveLength(1);
  });

  it('the pool error listener routes to the throttled outage warning', async() => { // risk: process crash on idle-client termination
    for (const implementation of [legacy, current] as Implementation[]) {
      await new ConnectScenario({}).run(implementation, 'connect');
      const warnings: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)); });
      vi.setSystemTime(1_900_000_000_000 + (implementation === legacy ? 0 : 1));
      const handler = recorder.state.handlers[0];
      handler(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }));
      handler(Object.assign(new Error('again'), { code: '57P01' }));
      spy.mockRestore();
      expect(warnings).toEqual(['sulla-vault: Postgres unavailable, requests return 503 until it recovers (57P01 terminating connection due to administrator command)']);
    }
  });
});
