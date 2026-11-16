// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs CollectionFilesFeedRepository's SQL against Postgres (the service-level behaviour is in FileListingQuery.test.ts).
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway database; each run creates and drops its own schema and applies 064/065.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollectionFilesFeedRepository } from '../src/Repositories/CollectionFilesFeedRepository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('CollectionFilesFeedRepository (real Postgres)', () => {
  const schema = `files_feed_repo_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${ schema }` });
  const repository = new CollectionFilesFeedRepository(pool, 'f.id,f.path,f.created_by_type');
  let collectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,current_version_id uuid,deleted_at timestamptz,
      created_by_type text NOT NULL DEFAULT 'user',created_by_id text NOT NULL DEFAULT 'u1',size bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT NOW(),
      extraction_status text NOT NULL DEFAULT 'indexed',extraction_reason_code text,UNIQUE(collection_id,path))`);
    await pool.query('CREATE TABLE file_folders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,deleted_at timestamptz)');
    await pool.query('CREATE TABLE file_versions(id uuid PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT NOW(),created_by_type text,created_by_id text,device_id text)');
    await pool.query('CREATE TABLE files_protected_files(file_id uuid PRIMARY KEY)');
    await pool.query(migration('064_fuse_directory_paging.sql'));
    await pool.query(migration('065_files_recent_listing.sql'));
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => { await pool.query('TRUNCATE files, file_versions, files_protected_files'); collectionId = randomUUID() });

  async function seed(path:string, options:{ createdByType?:string; minutesAgo?:number; size?:number; status?:string } = {}) {
    const versionId = randomUUID();
    await pool.query("INSERT INTO file_versions(id,created_by_type,created_by_id) VALUES($1,'agent','a-1')", [versionId]);
    await pool.query(`INSERT INTO files(collection_id,path,current_version_id,created_by_type,updated_at,size,extraction_status)
      VALUES($1,$2,$3,$4,NOW() - make_interval(mins => $5),$6,$7)`, [collectionId, path, versionId, options.createdByType ?? 'user', options.minutesAgo ?? 0, options.size ?? 1, options.status ?? 'indexed']);
  }

  // risk: Recent shows the wrong files, the wrong version author, or more rows than the caller asked for.
  it('returns exactly `limit` newest rows with the current version author, filtered by creator when given', async() => {
    await seed('a.md', { minutesAgo: 3 });
    await seed('b.md', { createdByType: 'agent', minutesAgo: 2 });
    await seed('c.md', { createdByType: 'agent-run', minutesAgo: 1 });
    const two = await repository.recent(collectionId, 2);
    expect(two.map(row => row.path)).toEqual(['c.md', 'b.md']);
    expect(two[0]).toMatchObject({ version_created_by_type: 'agent', version_created_by_id: 'a-1' });
    expect((await repository.recent(collectionId, 10, 'agent')).map(row => row.path)).toEqual(['b.md']);
    expect(await repository.recent(randomUUID(), 10)).toEqual([]);
  });

  // risk: folder badges count siblings that only share a name prefix, or miss nested files.
  it('groups the subtree under a slash-terminated prefix into one row per direct child folder', async() => {
    for (const path of ['p/x/1.md', 'p/x/deep/2.md', 'p/y/3.md', 'p/top.md', 'px/4.md']) await seed(path, { size: 10 });
    const rows = await repository.folderSummaries(collectionId, 'p/');
    expect(rows.map(row => [row.name, Number(row.file_count), Number(row.total_bytes)])).toEqual([['x', 2, 20], ['y', 1, 10]]);
  });

  // risk: an empty collection reports NaN or stale totals instead of zero.
  it('returns zero counts for an empty collection and per-status counts otherwise', async() => {
    expect(await repository.stats(collectionId)).toMatchObject({ file_count: '0', total_bytes: '0', failed: '0' });
    await seed('ok.md', { size: 4 }); await seed('bad.md', { size: 6, status: 'failed' });
    expect(await repository.stats(collectionId)).toMatchObject({ file_count: '2', total_bytes: '10', failed: '1', indexed: '1' });
  });
});
