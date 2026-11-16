// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * The statements the Files migrator runs on its one dedicated connection: the cross-process
 * advisory lock, the applied-migrations ledger, and running a migration script.
 */
export class SchemaMigrationRepository {
  /** Startup connectivity probe; throws while Postgres is unreachable. */
  async ping(db:Pick<pg.Pool, 'query'>):Promise<void> { await db.query('SELECT 1') }

  /** Terminates other sessions tagged with the migrator's application name. */
  async terminatePeers(client:Queryable, applicationName:string):Promise<void> {
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name=$1 AND pid<>pg_backend_pid()`, [applicationName]);
  }

  async lock(client:Queryable, key:number):Promise<void> { await client.query('SELECT pg_advisory_lock($1)', [key]) }
  async unlock(client:Queryable, key:number):Promise<void> { await client.query('SELECT pg_advisory_unlock($1)', [key]) }

  async tagSession(client:Queryable, applicationName:string):Promise<void> {
    await client.query("SELECT set_config('application_name',$1,false)", [applicationName]);
  }

  async ensureLedger(client:Queryable):Promise<void> {
    await client.query('CREATE TABLE IF NOT EXISTS files_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  }

  async isApplied(client:Queryable, version:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM files_schema_migrations WHERE version=$1', [version])).rowCount);
  }

  async recordApplied(client:Queryable, version:string):Promise<void> {
    await client.query('INSERT INTO files_schema_migrations(version) VALUES($1)', [version]);
  }

  async runScript(client:Queryable, sql:string):Promise<void> { await client.query(sql) }

  /** Whether the optional pgvector table exists, and whether the extension could be installed. */
  async vectorReadiness(client:Queryable):Promise<{ ready:boolean; available:boolean }> {
    return (await client.query("SELECT to_regclass('file_search_vectors') IS NOT NULL ready, EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') available")).rows[0];
  }
}
