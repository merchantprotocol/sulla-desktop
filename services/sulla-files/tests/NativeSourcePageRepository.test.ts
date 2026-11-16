// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real Postgres: keyset paging of the native source inventory (NativeSourcePageRepository +
// NativeSourcePager). Own schema, real 024 native-sources and 032 paging-index migrations.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NativeSourcePager } from '../src/nativeSourcePaging.js';
import { NativeSourcePageRepository } from '../src/Repositories/NativeSourcePageRepository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('native source paging (real Postgres)', () => {
  const schema = `files_native_page_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${ schema }` });
  const pager = new NativeSourcePager(new NativeSourcePageRepository(pool));
  let collectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY)');
    await pool.query('CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,current_version_id uuid)');
    await pool.query(migration('024_native_sources.sql'));
    await pool.query(migration('032_native_source_paging.sql'));
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE collections, files CASCADE');
    collectionId = randomUUID();
    await pool.query('INSERT INTO collections(id) VALUES($1)', [collectionId]);
  });

  const handle = (n:number) => `h${ String(n).padStart(42, '0') }`;
  async function seed(count:number, createdAt = '2026-11-01T00:00:00Z', state = 'active', from = 0) {
    for (let n = from; n < from + count; n++) {
      const file = (await pool.query('INSERT INTO files(collection_id,path,current_version_id) VALUES($1,$2,gen_random_uuid()) RETURNING id', [collectionId, `n/${ n }.md`])).rows[0].id;
      await pool.query(`INSERT INTO files_native_sources(source_handle,collection_id,file_id,display_name,source_revision,source_hash,state,created_at)
        VALUES($1,$2,$3,$4,$5,$5,$6,$7)`, [handle(n), collectionId, file, `${ n }.md`, 'a'.repeat(64), state, createdAt]);
    }
  }

  // risk: missed or duplicated sources — paging with the cursor returns every row exactly once, even with equal timestamps.
  it('returns every source exactly once across pages sharing one created_at', async() => {
    await seed(5);
    const seen:string[] = []; let after:string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await pager.page({ limit: 2, after });
      seen.push(...page.map(row => row.handle));
      if (page.length < 2) break;
      after = page.at(-1)!.cursor;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4].map(handle));
  });

  // risk: wrong inventory — the state filter applies, an unknown state is ignored and the limit is clamped.
  it('filters by known state, ignores an unknown one and clamps the limit', async() => {
    await seed(2); await seed(1, '2026-11-02T00:00:00Z', 'conflict', 2);
    expect((await pager.page({ state: 'conflict' })).map(row => [row.handle, row.state])).toEqual([[handle(2), 'conflict']]);
    expect(await pager.page({ state: 'bogus' })).toHaveLength(3);
    expect(await pager.page({ limit: 0 })).toHaveLength(1);
    expect((await pager.page({ after: 'not-a-cursor' })).map(row => row.handle)).toEqual([0, 1, 2].map(handle));
  });
});
