// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the FUSE read routes moved out of app.ts (FuseReadRoutes: /v1/fuse/directory, /entry,
// /tree with FuseTreeSnapshotCache and FuseTreeRepository), on the real app and a real Postgres.
// Written against the inline app.ts handlers before the move.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { FuseTreeRepository } from '../src/Repositories/FuseTreeRepository.js';
import { FuseTreeSnapshotCache } from '../src/Services/FuseTreeSnapshotCache.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files FUSE read routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const files:Record<string, string> = {};

  beforeAll(async() => {
    await fixture.start();
    for (const path of ['top.txt', 'docs/a.txt', 'docs/b.txt', 'docs/c.txt', 'docs/inner/d.txt', 'gone.txt']) files[path] = await fixture.createFile(path);
    expect((await fixture.request(`/v1/fuse/files/${ files['gone.txt'] }`, 'DELETE')).status).toBe(204);
  }, 30_000);
  afterAll(() => fixture.stop());

  const directory = (query:string, headers:Record<string, string> = {}) => fixture.request(`/v1/fuse/directory?${ query }`, 'GET', { headers });

  it('change feed returns per-collection path events and pages from a journal cursor', async() => {
    // risk: namespace isolation — ordinary audit writes and other collections must not invalidate this tree.
    const first = await fixture.request(`/v1/fuse/changes?collectionId=${ fixture.collectionId }`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ collectionId: fixture.collectionId, reset: true, more: false, changes: [] });
    const stable = await fixture.request(`/v1/fuse/changes?collectionId=${ fixture.collectionId }&since=${ first.body.cursor }`);
    expect(stable.body).toMatchObject({ cursor: first.body.cursor, reset: false, changes: [] });
    await fixture.createFile('feed/change.txt');
    const changed = await fixture.request(`/v1/fuse/changes?collectionId=${ fixture.collectionId }&since=${ first.body.cursor }`);
    expect(changed.body).toMatchObject({ reset: false, changes: [expect.objectContaining({ path: 'feed/change.txt', kind: 'insert' })] });
    const fileId = (await fixture.pool.query(`SELECT id FROM files WHERE collection_id=$1 AND path='feed/change.txt'`, [fixture.collectionId])).rows[0].id;
    await fixture.pool.query(`UPDATE files SET path='feed/renamed.txt' WHERE id=$1`, [fileId]);
    const rename = await fixture.request(`/v1/fuse/changes?collectionId=${ fixture.collectionId }&since=${ changed.body.cursor }`);
    expect(rename.body.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'feed/renamed.txt', oldPath: 'feed/change.txt', kind: 'rename' })]));
    await fixture.pool.query(`DELETE FROM files WHERE id=$1`, [fileId]);
    const deleted = await fixture.request(`/v1/fuse/changes?collectionId=${ fixture.collectionId }&since=${ rename.body.cursor }`);
    expect(deleted.body.changes).toContainEqual(expect.objectContaining({ path: 'feed/renamed.txt', kind: 'delete' }));
    const other = randomUUID();
    await fixture.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,$2,'Other','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$3)`, [other, fixture.userId, `spec-${ other }`]);
    expect((await fixture.request(`/v1/fuse/files?collectionId=${ other }&path=feed%2Fanother.txt`, 'POST', {
      body: Buffer.from('other collection'), headers: { 'content-type': 'application/octet-stream' },
    })).status).toBe(201);
    const isolated = await fixture.request(`/v1/fuse/changes?collectionId=${ fixture.collectionId }&since=${ deleted.body.cursor }`);
    expect(isolated.body.changes).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'feed/another.txt' })]));
    await fixture.pool.query(`INSERT INTO fuse_change_journal(collection_id,path,kind,changed_at) VALUES($1,'expired.txt','delete',now()-interval '11 minutes')`, [fixture.collectionId]);
    const expired = await fixture.request(`/v1/fuse/changes?collectionId=${ fixture.collectionId }&since=0`);
    expect(expired.body).toMatchObject({ reset: true, changes: [] });
    expect((await fixture.request('/v1/fuse/changes?collectionId=00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('lists one directory\'s live direct children, files and folders, keyset-paged', async() => {
    // risk: data accuracy — a skipped/repeated child or a trashed file in the mount corrupts the user's view.
    const root = await directory('path=');
    expect(root.status).toBe(200);
    expect(root.body.rootCollectionId).toBe(fixture.collectionId);
    expect(root.body.entries.map((entry:any) => [entry.kind, entry.path])).toEqual([['directory', 'docs'], ['file', 'top.txt']]);
    expect(root.body.nextCursor).toBeNull();
    const first = await directory(`collectionId=${ fixture.collectionId }&path=docs&limit=2`);
    expect(first.body.entries.map((entry:any) => entry.path)).toEqual(['docs/a.txt', 'docs/b.txt']);
    expect(first.body.nextCursor).toBe('docs/b.txt');
    expect(first.body.entries[0]).toMatchObject({ kind: 'file', id: files['docs/a.txt'], versionId: expect.any(String), mime: expect.any(String) });
    const second = await directory(`collectionId=${ fixture.collectionId }&path=docs&limit=2&cursor=docs/b.txt`);
    expect(second.body.entries.map((entry:any) => entry.path)).toEqual(['docs/c.txt', 'docs/inner']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('answers 304 for an unchanged directory revision and a new ETag after a change', async() => {
    // risk: data accuracy — a stale 304 after a write would hide new files from Finder.
    const first = await directory('path=docs');
    const etag = String(first.headers.etag);
    expect(etag).toBe(`"dir:${ fixture.collectionId }:docs:${ first.body.revision }"`);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect((await directory('path=docs', { 'if-none-match': etag })).status).toBe(304);
    await fixture.createFile('docs/e.txt');
    const changed = await directory('path=docs', { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('resolves one entry by path and 404s a trashed or missing one', async() => {
    // risk: data accuracy — the mount must never resolve a trashed file.
    expect(await fixture.request('/v1/fuse/entry?path=docs/a.txt')).toMatchObject({ status: 200, body: { kind: 'file', id: files['docs/a.txt'], collection_id: fixture.collectionId } });
    expect(await fixture.request('/v1/fuse/entry?path=docs/inner')).toMatchObject({ status: 200, body: { kind: 'directory', path: 'docs/inner', size: '0', versionId: null } });
    expect(await fixture.request('/v1/fuse/entry?path=gone.txt')).toMatchObject({ status: 404, body: { error: 'Files entry not found' } });
    expect((await fixture.request('/v1/fuse/entry?path=../x')).status).toBe(400);
  });

  it('serves the whole home tree with a revision ETag and 304 when unchanged', async() => {
    // risk: data accuracy — the tree is the mount's source of truth; it must hold only live home files.
    const tree = await fixture.request('/v1/fuse/tree');
    expect(tree.status).toBe(200);
    const etag = String(tree.headers.etag);
    expect(etag).toMatch(/^"home:\d+"$/);
    expect(tree.body.rootCollectionId).toBe(fixture.collectionId);
    expect(tree.body.collections.map((row:any) => [row.id, row.tree_path])).toEqual([[fixture.collectionId, '']]);
    expect(tree.body.files.map((row:any) => row.path)).not.toContain('gone.txt');
    expect(tree.body.files.map((row:any) => row.path)).toEqual(expect.arrayContaining(['top.txt', 'docs/a.txt', 'docs/inner/d.txt']));
    expect(tree.body.folders.map((row:any) => row.path)).toEqual(expect.arrayContaining(['docs', 'docs/inner']));
    expect((await fixture.request('/v1/fuse/tree', 'GET', { headers: { 'if-none-match': etag } })).status).toBe(304);
    await fixture.createFile('later.txt');
    const changed = await fixture.request('/v1/fuse/tree', 'GET', { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.body.files.map((row:any) => row.path)).toContain('later.txt');
  });

  it('FuseTreeSnapshotCache reuses a snapshot until the revision moves and shares one in-flight load', async() => {
    // risk: availability — every FUSE lookup rebuilding the multi-megabyte tree starves the pool.
    const repository = new FuseTreeRepository(fixture.pool);
    let loads = 0; const counting = Object.assign(Object.create(repository), { snapshot: (...args:Parameters<FuseTreeRepository['snapshot']>) => { loads++; return repository.snapshot(...args) } });
    const cache = new FuseTreeSnapshotCache(counting, { userId: fixture.userId });
    const [one, two] = await Promise.all([cache.load(), cache.load()]);
    expect(one).toBe(two);
    expect(loads).toBe(1);
    expect(await cache.load()).toBe(one);
    expect(loads).toBe(1);
    await fixture.createFile('cache/bump.txt');
    const next = await cache.load();
    expect(next.revision).not.toBe(one.revision);
    expect(loads).toBe(2);
    expect(JSON.parse(next.body.toString('utf8')).files.map((row:any) => row.path)).toContain('cache/bump.txt');
  });
});
