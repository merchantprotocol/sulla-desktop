// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 db/auth: the new classes behind db.ts/auth.ts work through their injected dependencies
// (clock, logger, sleep, pool factory, environment, repository) without globals.

import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { DesktopAccountBootstrapper } from '../../../../../../services/sulla-vault/src/auth/DesktopAccountBootstrapper';
import { VaultLoginVerifier } from '../../../../../../services/sulla-vault/src/auth/VaultLoginVerifier';
import type { VaultConfig } from '../../../../../../services/sulla-vault/src/config';
import { DatabaseOutageLog } from '../../../../../../services/sulla-vault/src/database/DatabaseOutageLog';
import { DatabaseReadiness } from '../../../../../../services/sulla-vault/src/database/DatabaseReadiness';
import { VaultDatabaseConnector } from '../../../../../../services/sulla-vault/src/database/VaultDatabaseConnector';
import { VaultDatabaseErrorClassifier } from '../../../../../../services/sulla-vault/src/database/VaultDatabaseErrorClassifier';
import { VaultMigrator } from '../../../../../../services/sulla-vault/src/database/VaultMigrator';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import type { PostgresDesktopAccountRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresDesktopAccountRepository';

class CollectingLogger {
  readonly lines: string[] = [];
  warn(message: unknown): void { this.lines.push(String(message)); }
}

class ScriptedPool {
  readonly queries: string[] = [];
  readonly listeners: Array<(error: Error) => void> = [];
  ended = false;

  constructor(readonly options: pg.PoolConfig, private readonly failures: unknown[] = []) {}

  on(_event: string, listener: (error: Error) => void): this { this.listeners.push(listener); return this; }
  async query(sql: string) {
    this.queries.push(sql);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { rowCount: 1, rows: [{}] };
  }
  async end(): Promise<void> { this.ended = true; }
}

class InMemoryAccounts {
  inserted: unknown[] = [];
  constructor(private readonly hasUsers: boolean) {}
  async anyUserExists(): Promise<boolean> { return this.hasUsers; }
  async insert(row: unknown): Promise<void> { this.inserted.push(row); }
}

describe('E9 db/auth classes work through injected dependencies', () => {
  it('the classifier reads its injected environment on every call', () => { // risk: outage misclassification
    const env: NodeJS.ProcessEnv = { SULLA_VAULT_DATABASE_URL: 'postgres://u@db.internal:5544/x' };
    const errors = new VaultDatabaseErrorClassifier(() => env);
    const dns = Object.assign(new Error('getaddrinfo'), { code: 'EAI_AGAIN', hostname: 'db.internal' });
    expect(errors.isTransient(dns)).toBe(true);
    env.SULLA_VAULT_DATABASE_URL = 'postgres://u@other:5544/x';
    expect(errors.isTransient(dns)).toBe(false);
    expect(errors.isTransient(Object.assign(new Error('x'), { code: 'ECONNRESET', port: 5544 }))).toBe(true);
  });

  it('each outage log instance owns its own throttle', () => { // risk: log flood / state leaking between instances
    let now = 1_000_000;
    const logger = new CollectingLogger();
    const log = new DatabaseOutageLog(new VaultDatabaseErrorClassifier(() => ({})), () => now, logger);
    const other = new DatabaseOutageLog(new VaultDatabaseErrorClassifier(() => ({})), () => now, logger);
    log.warn(new Error('a'));
    now += 29_999;
    log.warn(new Error('b'));
    other.warn(new Error('c'));
    now += 1;
    log.warn(new Error('d'));
    expect(logger.lines.map((line) => line.slice(-3))).toEqual(['(a)', '(c)', '(d)']);
  });

  it('readiness uses the injected sleep with the capped backoff', async() => { // risk: startup hang
    const sleeps: number[] = [];
    const logger = new CollectingLogger();
    const readiness = new DatabaseReadiness(new VaultDatabaseErrorClassifier(() => ({})), async(ms) => { sleeps.push(ms); }, logger);
    let calls = 0;
    const value = await readiness.untilReady('probe', async() => {
      if (++calls < 8) throw Object.assign(new Error('starting'), { code: '57P03' });
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
    expect(logger.lines).toHaveLength(1);
  });

  it('the connector builds pools through the injected factory and routes pool errors to the outage log', async() => { // risk: process crash on pool error
    const errors = new VaultDatabaseErrorClassifier(() => ({}));
    const logger = new CollectingLogger();
    const outage = new DatabaseOutageLog(errors, () => 5_000_000, logger);
    const pools: ScriptedPool[] = [];
    const connector = new VaultDatabaseConnector(outage, new DatabaseReadiness(errors, async() => {}, logger), (options) => {
      const pool = new ScriptedPool(options, pools.length === 1 ? [new Error('Connection terminated')] : []);
      pools.push(pool);
      return pool as unknown as pg.Pool;
    });
    const db = await connector.connect({ databaseUrl: 'postgres://vault', adminDatabaseUrl: 'postgres://admin' } as VaultConfig);
    expect(db).toBe(pools[1]);
    expect(pools[0].ended).toBe(true);
    expect(pools[1].queries).toEqual(['SELECT 1', 'SELECT 1']);
    pools[1].listeners[0](Object.assign(new Error('terminated'), { code: '57P01' }));
    expect(logger.lines.at(-1)).toBe('sulla-vault: Postgres unavailable, requests return 503 until it recovers (57P01 terminated)');
  });

  it('the migrator refuses to run when no migrations directory is found', async() => { // risk: silently skipping schema
    let connected = false;
    const db = { connect: async() => { connected = true; throw new Error('must not connect'); } } as unknown as Database;
    await expect(new VaultMigrator('/nonexistent/e9/src').migrate(db)).rejects.toThrow('Could not find vault migrations');
    expect(connected).toBe(false);
  });

  it('the bootstrapper inserts through its repository with a verifiable verifier', async() => { // risk: sign-in
    const accounts = new InMemoryAccounts(false);
    const verifiers = new VaultLoginVerifier();
    const config = { databaseUrl: 'x', desktopLoginHash: 'h', desktopPublicKey: 'pk', desktopEncryptedPrivateKey: { a: 1 }, desktopEncryptedUserKey: { b: 2 }, desktopKdf: { c: 3 } } as VaultConfig;
    await new DesktopAccountBootstrapper(accounts as unknown as PostgresDesktopAccountRepository, verifiers).ensure(config);
    expect(accounts.inserted).toHaveLength(1);
    const row = accounts.inserted[0] as { email: string; loginHashSalt: Buffer; loginHashVerifier: Buffer; publicKey: string; kdf: unknown };
    expect(row).toMatchObject({ email: 'desktop@local.sulla', publicKey: 'pk', kdf: { c: 3 } });
    expect(verifiers.verify('h', row.loginHashSalt, row.loginHashVerifier)).toBe(true);
    expect(verifiers.verify('H', row.loginHashSalt, row.loginHashVerifier)).toBe(false);

    const existing = new InMemoryAccounts(true);
    await new DesktopAccountBootstrapper(existing as unknown as PostgresDesktopAccountRepository, verifiers).ensure(config);
    expect(existing.inserted).toEqual([]);
  });
});
