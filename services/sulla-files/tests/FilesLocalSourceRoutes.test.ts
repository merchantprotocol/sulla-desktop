// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the desktop-local routes moved out of app.ts into LocalSourceRoutes (local identity/status,
// home-collection system-area helpers and ingest, native-source validation) with HomeSystemFileRepository,
// on the real app and a real Postgres.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files local source routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  beforeAll(() => fixture.start(), 30_000);
  afterAll(() => fixture.stop());
  const sha256 = (bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('answers local identity and status only to the local service token', async() => {
    // risk: permissions — /v1/local/* is reachable only with the local service token.
    expect(await fixture.request('/v1/local/identity')).toMatchObject({ status: 200, body: { principalId: fixture.userId } });
    expect(await fixture.request('/v1/local/identity', 'GET', { headers: { 'x-sulla-files-token': 'nope' } })).toMatchObject({ status: 401, body: { error: 'unauthorized local request' } });
    expect((await fixture.request('/v1/local/status')).status).toBe(200);
    expect((await fixture.request('/v1/local/system-areas')).body).toEqual(expect.any(Array));
  });

  it('mirrors system-area bytes once, answers unchanged bytes with 200 and refuses a hash mismatch', async() => {
    // risk: data accuracy / duplicate writes — re-ingesting the same bytes must not create another version.
    const bytes = Buffer.from('# use case'); const url = `/v1/local/system-areas/ingest?collectionId=${ fixture.collectionId }&path=Use%20Cases/a.md`;
    const first = await fixture.request(url, 'PUT', { body: bytes, headers: { 'content-type': 'text/markdown', 'x-sulla-source-hash': sha256(bytes) } });
    expect(first.status).toBe(201);
    const file = (await fixture.pool.query("SELECT id,current_version_id FROM files WHERE collection_id=$1 AND path='Use Cases/a.md'", [fixture.collectionId])).rows[0];
    expect((await fixture.pool.query('SELECT message,created_by_type FROM file_versions WHERE id=$1', [file.current_version_id])).rows[0]).toEqual({ message: 'Mirrored from a Sulla system area', created_by_type: 'user' });
    const again = await fixture.request(url, 'PUT', { body: bytes, headers: { 'content-type': 'text/markdown', 'x-sulla-source-hash': sha256(bytes) } });
    expect(again.status).toBe(200);
    expect((await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [file.id])).rows[0].current_version_id).toBe(file.current_version_id);
    expect(await fixture.request(url, 'PUT', { body: bytes, headers: { 'content-type': 'text/markdown', 'x-sulla-source-hash': sha256(Buffer.from('other')) } })).toMatchObject({ status: 409, body: { error: 'system-area bytes do not match their declared hash' } });
    // Regression: without a content-type express.raw leaves no body; that is a client error, not a 500.
    expect(await fixture.request(url, 'PUT', { body: Buffer.from('# changed'), headers: { 'x-sulla-source-hash': sha256(Buffer.from('# changed')) } })).toMatchObject({ status: 400, body: { error: 'request body must be raw bytes with a content-type' } });
    expect((await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [file.id])).rows[0].current_version_id).toBe(file.current_version_id);
  });

  it('records system-area audit events for home files and 404s unknown ones', async() => {
    // risk: audit integrity — events must attach only to home-collection files.
    const fileId = await fixture.createFile('audit/target.txt');
    expect((await fixture.request('/v1/local/system-areas/audit', 'POST', { body: { fileId, action: 'spec-event', details: { a: 1 } } })).status).toBe(204);
    expect((await fixture.pool.query("SELECT details FROM audit_log WHERE file_id=$1 AND action='spec-event'", [fileId])).rows).toEqual([{ details: { a: 1 } }]);
    expect((await fixture.request('/v1/local/system-areas/audit', 'POST', { body: { action: 'no-file' } })).status).toBe(204);
    expect(await fixture.request('/v1/local/system-areas/audit', 'POST', { body: { fileId: randomUUID() } })).toMatchObject({ status: 404, body: { error: 'Home collection file not found' } });
  });

  it('moves existing home files as the local owner, refuses unknown ones and occupied targets', async() => {
    // risk: data accuracy / permissions — only the local service token may move, the move lands exactly once, failures roll back.
    const fileId = await fixture.createFile('move/source.txt');
    await fixture.createFile('move/taken.txt');
    expect(await fixture.request('/v1/local/system-areas/move', 'POST', { body: { fileId: randomUUID(), targetPath: 'move/x.txt' } })).toMatchObject({ status: 404, body: { error: 'Home collection file not found' } });
    expect(await fixture.request('/v1/local/system-areas/move', 'POST', { body: { fileId, targetPath: 'moved/target.txt' }, token: null, headers: { 'x-sulla-files-token': 'nope' } })).toMatchObject({ status: 401, body: { error: 'unauthorized local request' } });
    expect((await fixture.request('/v1/local/system-areas/move', 'POST', { body: { fileId, targetPath: 'move/taken.txt' }, token: null })).status).toBe(409);
    expect((await fixture.pool.query('SELECT path FROM files WHERE id=$1', [fileId])).rows[0].path).toBe('move/source.txt');
    // Regression: /v1/local/* carries no bearer identity; the move used to ask for one, answer 401 and roll back.
    const moved = await fixture.request('/v1/local/system-areas/move', 'POST', { body: { fileId, targetPath: 'moved/deeper/target.txt' }, token: null });
    expect(moved).toMatchObject({ status: 200, body: { id: fileId, path: 'moved/deeper/target.txt' } });
    expect((await fixture.pool.query('SELECT path FROM files WHERE id=$1', [fileId])).rows[0].path).toBe('moved/deeper/target.txt');
    expect((await fixture.pool.query("SELECT path,created_by_id FROM file_folders WHERE collection_id=$1 AND path IN ('moved','moved/deeper') ORDER BY path", [fixture.collectionId])).rows)
      .toEqual([{ path: 'moved', created_by_id: fixture.userId }, { path: 'moved/deeper', created_by_id: fixture.userId }]);
    expect((await fixture.pool.query("SELECT details FROM audit_log WHERE file_id=$1 AND action='system-area-move'", [fileId])).rows).toEqual([{ details: { from: 'move/source.txt', to: 'moved/deeper/target.txt' } }]);
  });

  it('validates native-source metadata and proofs before reaching the native manager', async() => {
    // risk: data integrity — native publication requires well-formed operation identities and hashes.
    const bytes = Buffer.from('native');
    expect(await fixture.request(`/v1/local/native-sources/ingest?collectionId=${ fixture.collectionId }&path=n.txt`, 'PUT', { body: bytes })).toMatchObject({ status: 400, body: { error: 'valid native source operation metadata is required' } });
    const metadata = { 'x-sulla-operation-id': randomUUID(), 'x-sulla-source-handle': 'a'.repeat(43), 'x-sulla-source-revision': 'b'.repeat(64), 'x-sulla-source-hash': 'c'.repeat(64) };
    // Regression: valid metadata but no content-type leaves no raw body; refuse it with 400 instead of a 500.
    expect(await fixture.request(`/v1/local/native-sources/ingest?collectionId=${ fixture.collectionId }&path=n.txt`, 'PUT', { body: bytes, headers: { ...metadata, 'x-sulla-source-hash': sha256(bytes) } })).toMatchObject({ status: 400, body: { error: 'request body must be raw bytes with a content-type' } });
    expect(await fixture.request(`/v1/local/native-sources/ingest?collectionId=${ fixture.collectionId }&path=n.txt`, 'PUT', { body: bytes, headers: { ...metadata, 'content-type': 'application/octet-stream' } })).toMatchObject({ status: 409, body: { error: 'native source bytes do not match their declared hash' } });
    expect(await fixture.request('/v1/local/native-sources/publications', 'POST', { body: { fileId: 'x', baseVersionId: 'y' }, headers: metadata })).toMatchObject({ status: 400, body: { error: 'valid Files publication identity is required' } });
    expect(await fixture.request(`/v1/local/native-sources/publications/${ randomUUID() }/finish`, 'POST', { body: { nextSourceRevision: 'zz' } })).toMatchObject({ status: 400, body: { error: 'next source revision is invalid' } });
    expect(await fixture.request(`/v1/local/native-sources/publications/${ randomUUID() }/finish`, 'POST', { body: { conflictFileId: 'nope' } })).toMatchObject({ status: 400, body: { error: 'native conflict recovery proof is invalid' } });
    expect(await fixture.request('/v1/local/native-sources/revalidate', 'POST', { body: { handles: ['short'] } })).toMatchObject({ status: 400, body: { error: 'native source handles are invalid' } });
    expect(await fixture.request('/v1/local/native-sources/revalidate', 'POST', { body: { handles: [], replaceExisting: 'yes' } })).toMatchObject({ status: 400, body: { error: 'native source revalidation mode is invalid' } });
    expect(await fixture.request('/v1/local/native-sources/reselect-interrupted-publication', 'POST', { body: { fileId: randomUUID() } })).toMatchObject({ status: 400, body: { error: 'interrupted native publication reselection proof is invalid' } });
    const actions = await fixture.request('/v1/local/native-sources/actions');
    expect(actions).toMatchObject({ status: 200, body: [] });
    expect(actions.headers['cache-control']).toBe('private, no-store');
    expect(await fixture.request(`/v1/local/native-sources/actions/${ randomUUID() }/content`)).toMatchObject({ status: 404, body: { error: 'native publication action is unavailable' } });
  });
});
