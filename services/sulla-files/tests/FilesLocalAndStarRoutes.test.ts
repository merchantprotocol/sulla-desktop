// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes StarRoutes, LocalRootRoutes, LocalMaintenanceRoutes and SearchRoutes (moved out of
// app.ts) with StarRepository / ScratchMaintenanceRepository, on the real app and a real Postgres.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files star, local root, maintenance and search routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const files:Record<string, string> = {};

  beforeAll(async() => {
    await fixture.start();
    for (const path of ['docs/kept.txt', 'docs/trashed.txt', 'scratch/expired.txt', 'scratch/fresh.txt']) files[path] = await fixture.createFile(path);
  }, 30_000);
  afterAll(() => fixture.stop());

  const star = (method:'PUT' | 'DELETE', body:object, token?:string) => fixture.request('/v1/stars', method, { body: { collectionId: fixture.collectionId, ...body }, ...(token ? { token } : {}) });
  const stars = (token?:string) => fixture.request(`/v1/stars?collectionId=${ fixture.collectionId }`, 'GET', token ? { token } : {});

  it('stars files and folders per principal, hides trashed files and unstars', async() => {
    // risk: data accuracy — stars must be per principal and must not resurface trashed files.
    expect((await star('PUT', { fileId: files['docs/kept.txt'] })).status).toBe(204);
    expect((await star('PUT', { fileId: files['docs/kept.txt'] })).status).toBe(204);
    expect((await star('PUT', { folderPath: 'docs' })).status).toBe(204);
    expect((await star('PUT', { fileId: files['docs/trashed.txt'] })).status).toBe(204);
    expect((await fixture.request(`/v1/fuse/files/${ files['docs/trashed.txt'] }`, 'DELETE')).status).toBe(204);
    expect((await stars()).body).toEqual([
      { collectionId: fixture.collectionId, fileId: files['docs/kept.txt'] },
      { collectionId: fixture.collectionId, folderPath: 'docs' },
    ]);
    expect((await stars(fixture.token({ agent_id: 'agent-1', job_id: 'job-1' }))).body).toEqual([]);
    expect((await star('DELETE', { folderPath: 'docs' })).status).toBe(204);
    expect((await stars()).body).toEqual([{ collectionId: fixture.collectionId, fileId: files['docs/kept.txt'] }]);
  });

  it('refuses ambiguous or invalid star targets', async() => {
    // risk: data accuracy — a star must name exactly one valid target.
    expect(await star('PUT', { fileId: files['docs/kept.txt'], folderPath: 'docs' })).toMatchObject({ status: 400, body: { error: 'provide exactly one fileId or folderPath' } });
    expect(await star('DELETE', {})).toMatchObject({ status: 400, body: { error: 'provide exactly one fileId or folderPath' } });
    expect(await star('PUT', { folderPath: '../x' })).toMatchObject({ status: 400, body: { error: 'invalid Files path' } });
  });

  it('validates watched-folder root settings and requires the local token', async() => {
    // risk: permissions — local routes must stay behind the local service token.
    expect((await fixture.request('/v1/local/roots', 'GET', { headers: { 'x-sulla-files-token': 'wrong' } })).status).toBe(401);
    expect(await fixture.request('/v1/local/roots/default', 'PATCH', { body: { exclusions: 'nope' } })).toMatchObject({ status: 400, body: { error: 'exclusions must be an array of safe patterns' } });
    expect(await fixture.request('/v1/local/roots/default', 'PATCH', { body: { syncMode: 'cloud' } })).toMatchObject({ status: 400, body: { error: 'syncMode must be local or server' } });
  });

  it('maintenance expires only scratch files past their TTL, with a deleted version and journal entry', async() => {
    // risk: irreversible side effect — only expired files may be trashed, and each trash must be journaled.
    await fixture.pool.query("UPDATE files SET expires_at=NOW()-INTERVAL '1 hour' WHERE id=$1", [files['scratch/expired.txt']]);
    await fixture.pool.query("UPDATE files SET expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1", [files['scratch/fresh.txt']]);
    const result = await fixture.request('/v1/local/maintenance', 'POST', { body: {} });
    expect(result).toMatchObject({ status: 200, body: { expiredFiles: 1, pendingDisposals: 0 } });
    const expired = (await fixture.pool.query('SELECT f.deleted_at,v.deleted,v.message FROM files f JOIN file_versions v ON v.id=f.current_version_id WHERE f.id=$1', [files['scratch/expired.txt']])).rows[0];
    expect(expired).toMatchObject({ deleted: true, message: 'Scratch TTL expired' });
    expect(expired.deleted_at).not.toBeNull();
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM journal WHERE file_id=$1 AND op='delete'", [files['scratch/expired.txt']])).rows[0].n).toBe(1);
    expect((await fixture.pool.query('SELECT deleted_at FROM files WHERE id=$1', [files['scratch/fresh.txt']])).rows[0].deleted_at).toBeNull();
    expect((await fixture.request('/v1/local/maintenance', 'POST', { body: {} })).body.expiredFiles).toBe(0);
  });

  it('answers 503 when search is not configured', async() => {
    // risk: availability — a missing search index must fail clearly, not with a 500.
    expect(await fixture.request('/v1/search', 'POST', { body: { query: 'kept' } })).toMatchObject({ status: 503, body: { error: 'search unavailable' } });
  });
});
