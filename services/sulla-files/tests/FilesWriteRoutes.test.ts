// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the Files API write routes moved out of app.ts (FileWriteRoutes, FileContentWriteRoutes with
// FileWriteRepository and VersionRestoreRepository) on the real app and a real Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files API write routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  beforeAll(() => fixture.start(), 30_000);
  afterAll(() => fixture.stop());
  const row = async(id:string) => (await fixture.pool.query('SELECT path,current_version_id,deleted_at FROM files WHERE id=$1', [id])).rows[0];
  const read = async(id:string) => (await fixture.request(`/v1/fuse/files/${ id }/content`)).body;

  it('creates an empty file once and removes only empty folders', async() => {
    // risk: data accuracy — folder removal must never drop files or retained tombstones.
    const created = await fixture.request('/v1/files/empty', 'POST', { body: { collectionId: fixture.collectionId, path: 'crud/empty.txt' } });
    expect(created).toMatchObject({ status: 201, body: { path: 'crud/empty.txt', size: 0 } });
    expect(await fixture.request('/v1/files/empty', 'POST', { body: { collectionId: fixture.collectionId, path: 'crud/empty.txt' } })).toMatchObject({ status: 409, body: { error: 'A file or folder already exists at that Files path.' } });
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE file_id=$1 AND action='create-empty-file'", [created.body.id])).rows[0].n).toBe(1);
    expect(await fixture.request(`/v1/folders?collectionId=${ fixture.collectionId }&path=crud`, 'DELETE')).toMatchObject({ status: 409 });
    expect((await fixture.request('/v1/fuse/folders', 'POST', { body: { collectionId: fixture.collectionId, path: 'crud-empty/inner' } })).status).toBe(201);
    expect((await fixture.request(`/v1/folders?collectionId=${ fixture.collectionId }&path=crud-empty`, 'DELETE')).status).toBe(204);
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM file_folders WHERE collection_id=$1 AND path LIKE 'crud-empty%'", [fixture.collectionId])).rows[0].n).toBe(0);
    expect(await fixture.request(`/v1/folders?collectionId=${ fixture.collectionId }&path=crud-empty`, 'DELETE')).toMatchObject({ status: 404, body: { error: 'folder not found' } });
  });

  it('acknowledges a native conflict only for the displayed versions and audits it', async() => {
    // risk: data accuracy — keep-both must clear exactly the displayed conflict, once.
    const conflict = await fixture.createFile('crud/conflict.txt'); const source = await fixture.createFile('crud/source.txt');
    const versions = { currentVersionId: (await row(conflict)).current_version_id, sourceFileId: source, sourceVersionId: (await row(source)).current_version_id };
    const keep = (body:object) => fixture.request(`/v1/files/${ conflict }/conflicts/keep-both`, 'POST', { body });
    expect(await keep({ ...versions, sourceFileId: 'x' })).toMatchObject({ status: 400 });
    expect(await keep(versions)).toMatchObject({ status: 409, body: { error: 'This conflict changed. Refresh Files and try again.' } });
    await fixture.pool.query('INSERT INTO files_native_conflicts(file_id,source_file_id,content_hash) VALUES($1,$2,$3)', [conflict, source, 'a'.repeat(64)]);
    expect(await keep({ ...versions, sourceVersionId: randomUUID() })).toMatchObject({ status: 409, body: { error: 'One of the preserved files changed. Refresh Files and review both copies again.' } });
    expect((await keep(versions)).status).toBe(204);
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM files_native_conflicts WHERE file_id=$1', [conflict])).rows[0].n).toBe(0);
    expect((await fixture.pool.query("SELECT details FROM audit_log WHERE file_id=$1 AND action='conflict-keep-both'", [conflict])).rows[0].details).toEqual({ sourceFileId: source, sourceVersionId: versions.sourceVersionId });
    expect(await fixture.request(`/v1/files/${ conflict }/reindex`, 'POST', { body: {} })).toMatchObject({ status: 503, body: { error: 'indexing unavailable' } });
  });

  it('saves editor text against its base version and merges a stale base', async() => {
    // risk: lost updates — a save made against an older version must merge, not overwrite.
    const id = await fixture.createFile('crud/editor.md'); const v1 = (await row(id)).current_version_id;
    const save = (baseVersionId:string, content:string) => fixture.request(`/v1/files/${ id }/content`, 'PUT', { body: { baseVersionId, content } });
    expect(await save('nope', 'x')).toMatchObject({ status: 400, body: { error: 'baseVersionId and text content are required' } });
    expect(await save(randomUUID(), 'x')).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT', currentVersionId: v1 } });
    expect(await save(v1, 'top\nbody of crud/editor.md')).toMatchObject({ status: 200, body: { status: 'saved', content: 'top\nbody of crud/editor.md' } });
    const merged = await save(v1, 'body of crud/editor.md\nbottom');
    expect(merged).toMatchObject({ status: 200, body: { status: 'merged', content: 'top\nbody of crud/editor.md\nbottom' } });
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE file_id=$1 AND action='version-checked-save'", [id])).rows[0].n).toBe(2);
  });

  it('uploads against an expected base and imports with keep-both numbering', async() => {
    // risk: data accuracy — uploads must refuse a moved-on base; imports must never overwrite.
    const upload = (query:string, body:string) => fixture.request(`/v1/files/upload?collectionId=${ fixture.collectionId }&${ query }`, 'PUT', { body: Buffer.from(body), headers: { 'content-type': 'text/plain' } });
    const first = await upload('path=crud/upload.txt', 'one');
    expect(first).toMatchObject({ status: 201, body: { path: 'crud/upload.txt' } });
    expect(await upload(`path=crud/upload.txt&baseVersionId=${ randomUUID() }`, 'two')).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT', currentVersionId: first.body.current_version_id } });
    expect((await upload(`path=crud/upload.txt&baseVersionId=${ first.body.current_version_id }`, 'two')).status).toBe(201);
    expect(await read(first.body.id)).toBe('two');
    const importFile = (query:string) => fixture.request(`/v1/files/import?collectionId=${ fixture.collectionId }&path=crud/import.txt${ query }`, 'PUT', { body: Buffer.from('imported'), headers: { 'content-type': 'text/plain' } });
    expect(await importFile('')).toMatchObject({ status: 201, body: { path: 'crud/import.txt', requested_path: 'crud/import.txt', conflict_resolution: 'none' } });
    expect(await importFile('')).toMatchObject({ status: 409, body: { error: 'A file or folder already exists at that Files path.' } });
    expect(await importFile('&conflict=keep-both')).toMatchObject({ status: 201, body: { path: 'crud/import (1).txt', conflict_resolution: 'kept-both' } });
    expect(await fixture.request(`/v1/files/import?collectionId=${ fixture.collectionId }&path=crud/upload.txt/child.txt`, 'PUT', { body: Buffer.from('x') })).toMatchObject({ status: 409, body: { error: 'A file already occupies crud/upload.txt, so crud/upload.txt/child.txt cannot be stored there.' } });
  });

  it('trashes a file and restores an older version as a new current version', async() => {
    // risk: irreversible write — restore must bring back the old bytes as a new version and keep history.
    const id = await fixture.createFile('crud/restore.txt'); const v1 = (await row(id)).current_version_id;
    expect((await fixture.request(`/v1/files/${ id }/content`, 'PUT', { body: { baseVersionId: v1, content: 'changed' } })).status).toBe(200);
    const restored = await fixture.request(`/v1/files/${ id }/restore`, 'POST', { body: { versionId: v1 } });
    expect(restored).toMatchObject({ status: 200, body: { ok: true } });
    expect((await row(id)).current_version_id).toBe(restored.body.versionId);
    expect(await read(id)).toBe('body of crud/restore.txt');
    expect((await fixture.pool.query('SELECT message,manifest_hash=(SELECT manifest_hash FROM file_versions WHERE id=$2) AS same FROM file_versions WHERE id=$1', [restored.body.versionId, v1])).rows[0]).toEqual({ message: 'Restored version', same: true });
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM journal WHERE file_id=$1 AND op='restore'", [id])).rows[0].n).toBe(1);
    expect([403, 404]).toContain((await fixture.request(`/v1/files/${ id }/restore`, 'POST', { body: { versionId: randomUUID() } })).status);
    expect((await fixture.request(`/v1/files/${ id }`, 'DELETE')).status).toBe(204);
    expect((await row(id)).deleted_at).not.toBeNull();
  });
});
