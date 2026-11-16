// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import pg from 'pg';

import { TransactionScope } from './TransactionScope.js';
import { StartupDatabaseWait } from './StartupDatabaseWait.js';
import { FilesMigrator } from './FilesMigrator.js';
import { SchemaMigrationRepository } from './Repositories/SchemaMigrationRepository.js';

export { FilesMigrator } from './FilesMigrator.js';

/** Builds the Files service's guarded Postgres pool and waits (bounded) until it answers. */
export class FilesDatabase {
  constructor(private readonly schema = new SchemaMigrationRepository()) {}

  static poolMax(value = process.env.SULLA_FILES_DB_POOL_MAX):number {
    if (value === undefined) return 12;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) throw new Error('SULLA_FILES_DB_POOL_MAX must be an integer from 1 to 64');
    return parsed;
  }

  async connect(url:string, max = FilesDatabase.poolMax(), startup = new StartupDatabaseWait({ name: 'SullaFiles' })):Promise<pg.Pool> {
    // A request that cannot get a connection within 20 s fails (as a retryable 503) instead of
    // waiting forever: a pool starved by clients that each wait on the pool again never recovers.
    // On a 3-vCPU / 5-GB VM, 12 short metadata sessions absorb Desktop + agent bursts
    // without spending hundreds of MB on mostly waiting backends. More sessions do not
    // fix nested acquisition. Keep headroom for the other services; override for measured load.
    // 15s bounds abandoned transactions; 30s bounds individual statements (including lock waits).
    // Migrations can explicitly SET LOCAL statement_timeout for exceptional maintenance.
    const db = TransactionScope.guardPool(new pg.Pool({ connectionString: url, max,
      connectionTimeoutMillis: 20_000, idle_in_transaction_session_timeout: 15_000, statement_timeout: 30_000 }));
    // An idle client dropped by Postgres (restart, admin terminate) is replaced on next use; unhandled, it kills the service.
    db.on('error', error => console.error('[SullaFiles] idle database connection lost:', error.message));
    // pg-pool only listens on idle clients. A checked-out client that Postgres
    // terminates mid-transaction (25P03 idle-in-transaction timeout, admin
    // terminate) emits 'error' with no listener and crashes the whole service.
    // The in-flight query still rejects to its caller; this only stops the crash.
    db.on('connect', client => client.on('error', error => console.error('[SullaFiles] database connection lost during use:', error.message)));
    // Postgres may still be starting (or its DNS name not registered yet): wait, bounded.
    await startup.until('connect', () => this.schema.ping(db)); return db;
  }

  async connectOptional(url?:string):Promise<pg.Pool | undefined> { if (!url) return undefined; return this.connect(url) }
}

// Function exports kept for index.ts, app.ts and specs (outside this slice).
export function filesPoolMax(value = process.env.SULLA_FILES_DB_POOL_MAX):number { return FilesDatabase.poolMax(value) }
export function connect(url:string, max = filesPoolMax(), startup = new StartupDatabaseWait({ name: 'SullaFiles' })):Promise<pg.Pool> {
  return new FilesDatabase().connect(url, max, startup);
}
export function connectOptional(url?:string):Promise<pg.Pool | undefined> { return new FilesDatabase().connectOptional(url) }
export function migrate(db:pg.Pool):Promise<void> { return new FilesMigrator().migrate(db) }
