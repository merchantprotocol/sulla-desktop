// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import pg from 'pg';

import type { VaultConfig } from '../config.js';
import type { Database } from '../db.js';
import { PostgresVaultDatabaseRepository } from '../repositories/PostgresVaultDatabaseRepository.js';
import type { DatabaseOutageLog } from './DatabaseOutageLog.js';
import type { DatabaseReadiness } from './DatabaseReadiness.js';

export type VaultPoolFactory = (options: pg.PoolConfig) => pg.Pool;

/** Creates the sulla_vault database when an admin URL is configured, then opens and probes the vault pool. */
export class VaultDatabaseConnector {
  constructor(
    private readonly outageLog: DatabaseOutageLog,
    private readonly readiness: DatabaseReadiness,
    private readonly createPool: VaultPoolFactory = (options) => new pg.Pool(options),
  ) {}

  async ensureVaultDatabase(config: VaultConfig): Promise<void> {
    if (!config.adminDatabaseUrl) {
      return;
    }
    const admin = this.survivePoolErrors(this.createPool({ connectionString: config.adminDatabaseUrl, max: 1 }));
    try {
      const databases = new PostgresVaultDatabaseRepository(admin);
      if (await databases.isVaultDatabaseMissing()) {
        await databases.createVaultDatabase();
      }
    } finally {
      await admin.end();
    }
  }

  async connect(config: VaultConfig): Promise<Database> {
    await this.readiness.untilReady('database setup', () => this.ensureVaultDatabase(config));
    const db = this.survivePoolErrors(this.createPool({
      connectionString:        config.databaseUrl,
      max:                     10,
      // Fail fast when the pool is starved instead of queueing callers forever.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis:       30_000,
    }));
    const probe = new PostgresVaultDatabaseRepository(db);
    await this.readiness.untilReady('connect', () => probe.ping());
    return db;
  }

  /**
   * An idle pooled client can be terminated by the server (restart, 57P01).
   * Without a listener Node throws the 'error' event and kills the process; with
   * one, pg discards the dead client and the next query reconnects.
   */
  private survivePoolErrors(pool: pg.Pool): pg.Pool {
    pool.on('error', (error) => {
      this.outageLog.warn(error);
    });
    return pool;
  }
}
