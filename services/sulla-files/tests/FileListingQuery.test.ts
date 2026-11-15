// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Runs the real listing / recent / stats SQL against Postgres. Point SULLA_FILES_TEST_DATABASE_URL at a
// throwaway database (e.g. `docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine`).
// Each run creates and drops its own schema, applying the real 064/065 migrations for parent_path and indexes.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileListingQuery } from '../src/FileListingQuery.js';
import { CollectionFilesFeed } from '../src/CollectionFilesFeed.js';
import { ListingPage } from '../src/ListingPage.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('folder listing, recent and stats SQL (real Postgres)', () => {
  const schema = `files_listing_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const query = new FileListingQuery();
  let collectionId = '';
  let otherCollectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`SET search_path TO ${ schema }`);
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
  beforeEach(async() => {
    await pool.query('TRUNCATE files, file_versions, files_protected_files');
    collectionId = randomUUID(); otherCollectionId = randomUUID();
  });

  async function seed(paths:string[], options:{ collection?:string; deleted?:boolean; protected?:boolean; createdByType?:string; createdById?:string; updatedAt?:string; size?:number; status?:string; reason?:string } = {}) {
    for (const path of paths) {
      const versionId = randomUUID();
      await pool.query('INSERT INTO file_versions(id,device_id) VALUES($1,$2)', [versionId, 'device-1']);
      const row = await pool.query(`INSERT INTO files(collection_id,path,current_version_id,deleted_at,created_by_type,created_by_id,updated_at,size,extraction_status,extraction_reason_code)
        VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW()),$8,$9,$10) RETURNING id`,
      [options.collection ?? collectionId, path, versionId, options.deleted ? new Date() : null, options.createdByType ?? 'user', options.createdById ?? 'u1', options.updatedAt ?? null, options.size ?? 1, options.status ?? 'indexed', options.reason ?? null]);
      if (options.protected) await pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [row.rows[0].id]);
    }
  }

  /** Pages exactly like GET /v1/files: fetch limit+1 rows, continue from an opaque cursor over the last path. */
  async function listAll(path:string, pageSize:number, options:{ childrenOnly?:boolean; trash?:boolean } = {}) {
    const pages:string[][] = []; let cursor:string|undefined;
    for (;;) {
      const page = ListingPage.parse(String(pageSize), cursor);
      const scope = query.build({ collectionId, path, childrenOnly: options.childrenOnly ?? true, trash: options.trash ?? false, after: page.after, limit: page.limit + 1 });
      const rows = (await pool.query(`SELECT f.path FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id WHERE ${ scope.where } ${ scope.orderLimit }`, scope.values)).rows.map(row => row.path as string);
      const headers = new Map<string, string>();
      page.apply({ setHeader: (name:string, value:string) => headers.set(name, value) }, rows.length > page.limit, rows.slice(0, page.limit).at(-1));
      pages.push(rows.slice(0, page.limit));
      if (headers.get('X-Has-More') !== 'true') return { paths: pages.flat(), pages };
      cursor = headers.get('X-Next-Cursor');
      if (pages.length > 1000) throw new Error('listing did not terminate');
    }
  }

  // risk: data loss — a folder whose listing spans several pages must show every file exactly once.
  it('lists a folder\'s direct children exactly across page boundaries', async() => {
    await seed(['docs/1.md', 'docs/2.md', 'docs/3.md', 'docs/4.md', 'docs/5.md', 'docs/sub/deep.md', 'docs-old/x.md', 'docs old/y.md', 'docsx.md', 'aaa.md']);
    const result = await listAll('docs', 2);
    expect(result.paths).toEqual(['docs/1.md', 'docs/2.md', 'docs/3.md', 'docs/4.md', 'docs/5.md']);
    expect(result.pages).toEqual([['docs/1.md', 'docs/2.md'], ['docs/3.md', 'docs/4.md'], ['docs/5.md']]);
    expect((await listAll('docs', 3)).paths).toEqual(['docs/1.md', 'docs/2.md', 'docs/3.md', 'docs/4.md', 'docs/5.md']);
  });

  // risk: wrong folder contents — prefix-sharing siblings must never leak into each other.
  it('keeps siblings with common prefixes (a, a-b, "a b", a/b) apart', async() => {
    await seed(['a/one.txt', 'a-b/two.txt', 'a b/three.txt', 'a/b/four.txt', 'ab.txt', 'a.txt', 'a/b-c/five.txt']);
    expect((await listAll('a', 2)).paths).toEqual(['a/one.txt']);
    expect((await listAll('a/b', 2)).paths).toEqual(['a/b/four.txt']);
    expect((await listAll('a-b', 2)).paths).toEqual(['a-b/two.txt']);
    expect((await listAll('a b', 2)).paths).toEqual(['a b/three.txt']);
    expect((await listAll('a/b-c', 2)).paths).toEqual(['a/b-c/five.txt']);
  });

  // risk: root listing hides top-level files or floods with the whole collection.
  it('lists only top-level files at the root (path = \'\')', async() => {
    await seed(['readme.md', 'notes.txt', 'docs/inner.md', 'docs/sub/deeper.md']);
    await seed(['other-root.md'], { collection: otherCollectionId });
    expect((await listAll('', 1)).paths).toEqual(['notes.txt', 'readme.md']);
  });

  // risk: deleted or protected (wallet/vault) files appearing in a folder listing.
  it('excludes deleted and protected files from the active listing', async() => {
    await seed(['docs/live.md']);
    await seed(['docs/gone.md'], { deleted: true });
    await seed(['docs/secret.key'], { protected: true });
    expect((await listAll('docs', 2)).paths).toEqual(['docs/live.md']);
  });

  // risk: Trash breaks — the existing subtree trash listing must keep its prefix semantics.
  it('keeps the trash and legacy subtree listings unchanged', async() => {
    await seed(['docs/live.md', 'docs/sub/live2.md']);
    await seed(['docs/gone.md', 'docs/sub/gone2.md', 'docs-old/gone3.md', 'top-gone.md'], { deleted: true });
    expect((await listAll('', 2, { childrenOnly: false, trash: true })).paths).toEqual(['docs-old/gone3.md', 'docs/gone.md', 'docs/sub/gone2.md', 'top-gone.md']);
    expect((await listAll('docs', 2, { childrenOnly: false, trash: true })).paths).toEqual(['docs/gone.md', 'docs/sub/gone2.md']);
    expect((await listAll('docs', 2, { childrenOnly: false })).paths).toEqual(['docs/live.md', 'docs/sub/live2.md']);
  });

  // risk: data loss at scale — a folder sorting after 20,000+ other paths must still list completely on page one.
  it('lists a late-sorting folder fully even with 20,000+ earlier paths', async() => {
    await pool.query(`INSERT INTO files(collection_id,path,current_version_id) SELECT $1,'aaa/file-'||lpad(g::text,6,'0'),gen_random_uuid() FROM generate_series(1,20050) g`, [collectionId]);
    await seed(['zzz/a.md', 'zzz/b.md', 'zzz/c.md']);
    const result = await listAll('zzz', 250);
    expect(result.paths).toEqual(['zzz/a.md', 'zzz/b.md', 'zzz/c.md']);
    expect(result.pages).toHaveLength(1);
  });

  // risk: unbounded reads — Recent must be capped, newest first, and only show active visible files.
  it('returns a bounded, newest-first recent list', async() => {
    await pool.query(`INSERT INTO files(collection_id,path,current_version_id,updated_at) SELECT $1,'bulk/f-'||lpad(g::text,4,'0'),gen_random_uuid(),TIMESTAMPTZ '2026-01-01'+g*INTERVAL '1 minute' FROM generate_series(1,260) g`, [collectionId]);
    await seed(['newest/gone.md'], { deleted: true, updatedAt: '2027-01-01' });
    await seed(['newest/wallet.json'], { protected: true, updatedAt: '2027-01-01' });
    await seed(['newest/_folder-metadata.yaml'], { updatedAt: '2027-01-01' });
    await seed(['newest/other.md'], { collection: otherCollectionId, updatedAt: '2027-01-01' });
    await seed(['newest/agent.md'], { createdByType: 'agent-run', createdById: 'run-1', updatedAt: '2026-12-01' });
    const feed = new CollectionFilesFeed(pool, 'f.id,f.path,f.updated_at,f.created_by_type');
    const capped = await feed.recent({ collectionId, limit: '5000' });
    expect(capped).toHaveLength(CollectionFilesFeed.maxLimit);
    const top = await feed.recent({ collectionId, limit: 3 });
    expect(top.map(row => row.path)).toEqual(['newest/agent.md', 'bulk/f-0260', 'bulk/f-0259']);
    const times = capped.map(row => new Date(row.updated_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((await feed.recent({ collectionId, limit: 50, createdByType: 'agent-run' })).map(row => row.path)).toEqual(['newest/agent.md']);
    await expect(feed.recent({ collectionId, limit: 5, createdByType: "user' OR 1=1 --" })).rejects.toThrow(RangeError);
  });

  // risk: misleading storage and badge figures — totals must cover the whole collection, not the open folder.
  it('counts the whole collection server-side for stats', async() => {
    await seed(['a/1.md', 'a/b/2.md', 'z/3.md'], { size: 100 });
    await seed(['agents/x.md', 'agents/y.md'], { createdByType: 'agent-run', createdById: 'run-1', size: 10, status: 'pending' });
    await seed(['agents/z.md'], { createdByType: 'agent-run', createdById: 'run-2', size: 10, status: 'indexed', reason: 'text_partial' });
    await seed(['gone.md'], { deleted: true, size: 999 });
    await seed(['vault/key.md'], { protected: true, size: 999 });
    await seed(['a/_folder-metadata.yaml', '_folder-metadata.yaml'], { size: 999 });
    await seed(['other.md'], { collection: otherCollectionId, size: 999 });
    const stats = await new CollectionFilesFeed(pool, 'f.id').stats(collectionId);
    expect(stats.fileCount).toBe(6);
    expect(stats.totalBytes).toBe(330);
    expect(stats.agentRunCount).toBe(2);
    expect(stats.indexing).toMatchObject({ total: 6, pending: 2, indexed: 4, partial: 1, complete: false });
  });
});

describe('FileListingQuery binding', () => {
  // risk: wrong folder contents — the root must bind '' (not '/'), and children never use a prefix match.
  it('binds the raw folder path for direct children and a slash-terminated prefix for subtrees', () => {
    const query = new FileListingQuery();
    const root = query.build({ collectionId: 'c', path: '', childrenOnly: true, trash: false, after: '', limit: 3 });
    expect(root.where).toContain('f.parent_path=$2');
    expect(root.where).not.toContain('starts_with');
    expect(root.values).toEqual(['c', '', '', 3]);
    const subtree = query.build({ collectionId: 'c', path: 'a', childrenOnly: false, trash: true, deviceId: 'd', after: 'a/x', limit: 3 });
    expect(subtree.values).toEqual(['c', 'a/', 'a/x', 'd', 3]);
    expect(subtree.where).toContain('f.deleted_at IS NOT NULL');
  });
});
