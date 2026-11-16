// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres: the migration ledger statements FilesMigrator relies on. The advisory lock and
// peer termination are deliberately not exercised here (they are database-wide).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaMigrationRepository } from '../src/Repositories/SchemaMigrationRepository.js';
import { TransactionControlRepository } from '../src/Repositories/TransactionControlRepository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('schema migration ledger (real Postgres)', () => {
  const schemaName = `files_migration_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${ schemaName }`, max: 1 });
  const schema = new SchemaMigrationRepository();
  const control = new TransactionControlRepository();

  beforeAll(async() => { await pool.query(`CREATE SCHEMA ${ schemaName }`) });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schemaName } CASCADE`); await pool.end() });

  it('records a migration only when its script commits, so a failed script is retried on the next start', async() => {
    // risk: schema integrity — a migration marked applied without its changes would never run again.
    const client = await pool.connect();
    try {
      await schema.ping(pool);
      await schema.ensureLedger(client); await schema.ensureLedger(client);
      expect(await schema.isApplied(client, '900_spec.sql')).toBe(false);

      await control.begin(client);
      await schema.runScript(client, 'CREATE TABLE spec_failed(id int); SELECT 1/0;').catch(() => undefined);
      await control.rollback(client);
      expect(await schema.isApplied(client, '900_spec.sql')).toBe(false);
      expect((await client.query("SELECT to_regclass('spec_failed') IS NULL gone")).rows[0].gone).toBe(true);

      await control.begin(client);
      await schema.runScript(client, 'CREATE TABLE spec_applied(id int)');
      await schema.recordApplied(client, '900_spec.sql');
      await control.commit(client);
      expect(await schema.isApplied(client, '900_spec.sql')).toBe(true);
      await expect(schema.recordApplied(client, '900_spec.sql')).rejects.toThrow();
      expect(await schema.vectorReadiness(client)).toMatchObject({ ready: false });
    } finally { client.release() }
  });
});
