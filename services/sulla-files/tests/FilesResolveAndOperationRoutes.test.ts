// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the routes moved out of app.ts in this slice (FileResolveRoutes: GET /v1/files/resolve;
// FileOperationRoutes: /v1/database-file-operations* and POST /v1/file-operations) with
// FileLocatorRepository, on the real app and a real Postgres. Written against the inline handlers.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FileLocatorRepository } from '../src/Repositories/FileLocatorRepository.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files resolve and file-operation routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const files:Record<string, string> = {};

  beforeAll(async() => {
    await fixture.start();
    for (const path of ['docs/a.txt', 'docs/sub/b.txt', 'other/c.txt', 'trashed/t.txt']) files[path] = await fixture.createFile(path);
    expect((await fixture.request(`/v1/fuse/files/${ files['trashed/t.txt'] }`, 'DELETE')).status).toBe(204);
  }, 30_000);
  afterAll(() => fixture.stop());

  const resolve = (path:string) => fixture.request(`/v1/files/resolve?path=${ encodeURIComponent(path) }`);

  it('resolves mounted absolute paths to a file or folder of a viewable collection', async() => {
    // risk: permissions/data accuracy — the resolver must map /mnt/sulla-files paths exactly and never to trashed files.
    expect(await resolve('/mnt/sulla-files/docs/sub/b.txt')).toMatchObject({ status: 200, body: { collectionId: fixture.collectionId, fileId: files['docs/sub/b.txt'], folderPath: 'docs/sub', kind: 'file' } });
    expect(await resolve('/mnt/sulla-files/docs')).toMatchObject({ status: 200, body: { collectionId: fixture.collectionId, folderPath: 'docs', kind: 'folder' } });
    expect(await resolve('/mnt/sulla-files/Files/docs/a.txt')).toMatchObject({ status: 200, body: { fileId: files['docs/a.txt'], folderPath: 'docs', kind: 'file' } });
    expect(await resolve('/mnt/sulla-files/trashed/t.txt')).toMatchObject({ status: 404, body: { error: 'Files path not found' } });
    expect(await resolve('/etc/passwd')).toMatchObject({ status: 400, body: { error: 'path must be under /mnt/sulla-files' } });
    expect((await fixture.request('/v1/files/resolve?path=/mnt/sulla-files/docs', 'GET', { token: null })).status).toBe(401);
  });

  it('validates file-operation requests before touching any file', async() => {
    // risk: data integrity — malformed moves/copies and folder-into-itself moves must be refused.
    const operate = (body:object) => fixture.request('/v1/file-operations', 'POST', { body: { collectionId: fixture.collectionId, ...body } });
    expect(await operate({ action: 'delete', items: [{ fileId: files['docs/a.txt'], targetPath: 'x.txt' }] })).toMatchObject({ status: 400, body: { error: 'action and 1-250 items are required' } });
    expect(await operate({ action: 'move', items: [] })).toMatchObject({ status: 400, body: { error: 'action and 1-250 items are required' } });
    expect(await operate({ action: 'move', items: [{ targetPath: 'x.txt' }] })).toMatchObject({ status: 400, body: { error: 'each item requires fileId or folderPath' } });
    expect(await operate({ action: 'move', items: [{ folderPath: 'docs', targetPath: 'docs/sub/again' }] })).toMatchObject({ status: 400, body: { error: 'a folder cannot be moved or copied into itself' } });
    expect(await operate({ action: 'move', items: [{ fileId: files['docs/a.txt'], targetPath: '../escape.txt' }] })).toMatchObject({ status: 400, body: { error: 'invalid Files path' } });
    expect((await fixture.pool.query('SELECT path FROM files WHERE id=$1', [files['docs/a.txt']])).rows[0].path).toBe('docs/a.txt');
  });

  it('keeps the database-operation routes behind authentication', async() => {
    // risk: permissions — batch operations must never run unauthenticated.
    expect((await fixture.request('/v1/database-file-operations', 'POST', { body: {}, token: null })).status).toBe(401);
    expect((await fixture.request(`/v1/database-file-operations/capabilities?collectionId=${ fixture.collectionId }`, 'GET', { token: null })).status).toBe(401);
  });

  it('FileLocatorRepository reads published collections, live files, folders and a folder subtree', async() => {
    // risk: data accuracy — the subtree must include nested files in path order and exclude trashed ones.
    const repository = new FileLocatorRepository(fixture.pool);
    expect((await repository.publishedCollections()).map(row => row.id)).toEqual([fixture.collectionId]);
    expect(await repository.liveFileId(fixture.collectionId, 'docs/a.txt')).toBe(files['docs/a.txt']);
    expect(await repository.liveFileId(fixture.collectionId, 'trashed/t.txt')).toBeUndefined();
    expect(await repository.liveFolderExists(fixture.collectionId, 'docs/sub')).toBe(true);
    expect(await repository.liveFolderExists(fixture.collectionId, 'nope')).toBe(false);
    expect((await repository.liveSubtreeFiles(fixture.collectionId, 'docs')).map(row => row.path)).toEqual(['docs/a.txt', 'docs/sub/b.txt']);
    expect(await repository.liveSubtreeFiles(fixture.collectionId, 'trashed')).toEqual([]);
  });
});
