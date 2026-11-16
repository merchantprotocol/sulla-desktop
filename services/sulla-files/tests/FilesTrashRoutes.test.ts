// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes TrashRoutes (moved out of app.ts) with TrashListingRepository on the real app and a real Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files trash routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const files:Record<string, string> = {};

  beforeAll(async() => {
    await fixture.start();
    for (const path of ['bin/old.txt', 'bin/keep.txt']) files[path] = await fixture.createFile(path);
    const trashed = await fixture.request(`/v1/fuse/files/${ files['bin/old.txt'] }`, 'DELETE');
    if (trashed.status !== 204) throw new Error(`trash ${ trashed.status } ${ JSON.stringify(trashed.body) }`);
  }, 30_000);
  afterAll(() => fixture.stop());

  const trash = () => fixture.request(`/v1/trash?collectionId=${ fixture.collectionId }`);

  it('lists only trashed files with their current tombstone and undo state', async() => {
    // risk: data accuracy — live files must never appear in Trash, and the tombstone must be the current version.
    const listed = await trash();
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    const head = (await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [files['bin/old.txt']])).rows[0].current_version_id;
    expect(listed.body[0]).toMatchObject({ kind: 'file', id: files['bin/old.txt'], path: 'bin/old.txt', revision: expect.any(String),
      currentTombstone: { kind: 'version', id: head, undo: { state: 'unavailable' } }, capabilities: expect.any(Object) });
    expect((await fixture.request(`/v1/trash?collectionId=${ randomUUID() }`)).status).toBe(404);
  });

  it('validates restore and purge requests before touching data', async() => {
    // risk: data accuracy — malformed tombstone references must be refused, not guessed.
    const id = files['bin/old.txt'];
    expect(await fixture.request(`/v1/trash/${ id }/restore`, 'POST', { body: { kind: 'bogus' } })).toMatchObject({ status: 400, body: { error: 'kind must be file or folder' } });
    expect(await fixture.request(`/v1/trash/${ id }/restore`, 'POST', { body: { currentTombstone: { receiptId: 7 } } })).toMatchObject({ status: 400, body: { error: 'currentTombstone.receiptId must be a string' } });
    expect(await fixture.request(`/v1/trash/${ id }/restore`, 'POST', { body: { kind: 'folder', currentTombstone: { id: 'a', receiptId: 'b' } } })).toMatchObject({ status: 400, body: { error: 'currentTombstone id and receiptId must match' } });
    expect(await fixture.request(`/v1/trash/${ id }/purge`, 'DELETE', { body: { kind: 'folder', currentTombstone: { id: 'a', receiptId: 'b' } } })).toMatchObject({ status: 400, body: { error: 'currentTombstone id and receiptId must match' } });
    expect((await fixture.pool.query('SELECT deleted_at FROM files WHERE id=$1', [id])).rows[0].deleted_at).not.toBeNull();
  });

  it('restores a trashed file as a new live version and empties Trash', async() => {
    // risk: CRUD — restore must bring back the file content and leave Trash consistent.
    const [entry] = (await trash()).body;
    const restored = await fixture.request(`/v1/trash/${ entry.id }/restore`, 'POST', { body: { kind: 'file', currentTombstone: { id: entry.currentTombstone.id }, expectedRevision: entry.revision } });
    expect(restored).toMatchObject({ status: 200, body: { status: 'restored', kind: 'file', id: entry.id, path: 'bin/old.txt', currentTombstone: null } });
    const row = (await fixture.pool.query('SELECT f.deleted_at,v.deleted FROM files f JOIN file_versions v ON v.id=f.current_version_id WHERE f.id=$1', [entry.id])).rows[0];
    expect(row).toMatchObject({ deleted_at: null, deleted: false });
    expect((await trash()).body).toEqual([]);
    expect((await fixture.request(`/v1/trash/${ entry.id }/restore`, 'POST', { body: { kind: 'file' } })).status).toBe(409);
  });
});
