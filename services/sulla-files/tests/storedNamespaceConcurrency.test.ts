// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockStoredNamespace } from '../src/storedNamespace.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('stored namespace concurrency (real Postgres)', () => {
  const schema = `namespace_concurrency_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `namespace-concurrency-${randomUUID().slice(0, 8)}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 16, application_name: applicationName });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid NOT NULL, path text NOT NULL)`);
    await admin.query(`CREATE FUNCTION ${schema}.guard_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('stored-namespace:'||NEW.collection_id,0));
        IF EXISTS (SELECT 1 FROM ${schema}.files WHERE collection_id=NEW.collection_id AND path=NEW.path) THEN
          RAISE EXCEPTION 'duplicate namespace path' USING ERRCODE='23505';
        END IF;
        RETURN NEW;
      END $$`);
    await admin.query(`CREATE TRIGGER namespace_guard BEFORE INSERT ON ${schema}.files FOR EACH ROW EXECUTE FUNCTION ${schema}.guard_namespace()`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  // risk: data loss / EIO under concurrent Files creates — scoped locks must match the trigger's
  // exclusive collection key, including different sibling paths under the same parent.
  it('commits 16 concurrent sibling creates without deadlock, EIO, or lingering transactions', async () => {
    const collectionId = randomUUID();
    const outcomes = await Promise.allSettled(Array.from({ length: 16 }, async (_, index) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO ${schema}`);
        const path = `shared-parent/file-${index}.txt`;
        await lockStoredNamespace(client, collectionId, path);
        await client.query('INSERT INTO files(collection_id,path) VALUES($1,$2)', [collectionId, path]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }));
    const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    expect(failures.map(error => ({ code: error?.code, message: error?.message }))).toEqual([]);
    expect(failures.some(error => error?.code === 'EIO')).toBe(false);
    expect((await admin.query(`SELECT count(*)::int n FROM ${schema}.files WHERE collection_id=$1`, [collectionId])).rows[0].n).toBe(16);
    expect((await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND state LIKE 'idle in transaction%'`, [applicationName])).rows[0].n).toBe(0);
  }, 20_000);
});
