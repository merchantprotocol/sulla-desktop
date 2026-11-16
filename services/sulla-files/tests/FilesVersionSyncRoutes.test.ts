// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the remote version sync routes moved out of app.ts (VersionSyncRoutes: POST
// /v1/versions/prepare and /commit with RemoteVersionBundleValidator, RemoteVersionSync and
// RemoteVersionRepository), on the real app and a real Postgres. Written against the inline handlers.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RemoteVersionBundleValidator } from '../src/Services/RemoteVersionBundleValidator.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files remote version prepare/commit routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();

  beforeAll(() => fixture.start(), 30_000);
  afterAll(() => fixture.stop());

  /** A self-consistent remote bundle for one version of `fileId` at `path`. */
  const bundle = (input:{ fileId?:string; versionId?:string; path:string; size?:number; base?:string | null }) => {
    const size = input.size ?? 11; const ids = [randomBytes(32).toString('hex')];
    const hash = createHash('sha256').update(JSON.stringify({ ids, size })).digest('hex');
    return {
      collectionId: fixture.collectionId, baseServerVersionId: input.base ?? null,
      file: { id: input.fileId ?? randomUUID(), path: input.path, mime: 'text/plain', size, search_text: 'remote text' },
      version: { id: input.versionId ?? randomUUID(), chunk_collection_id: fixture.collectionId, size, deleted: false, message: 'remote write' },
      manifest: { hash, chunk_ids: ids, total_size: size },
      chunks: [{ id: ids[0], size, stored_size: size + 28, location: `chunks/${ fixture.collectionId }/${ ids[0] }` }],
    };
  };
  const uploadChunks = async(remote:ReturnType<typeof bundle>) => {
    for (const chunk of remote.chunks) expect((await fixture.request(`/v1/chunks/${ fixture.collectionId }/${ chunk.id }`, 'PUT', { body: Buffer.alloc(chunk.stored_size, 1), headers: { 'content-type': 'application/octet-stream' } })).status).toBe(204);
  };
  const prepare = (body:object) => fixture.request('/v1/versions/prepare', 'POST', { body });
  const commit = (body:object) => fixture.request('/v1/versions/commit', 'POST', { body });

  it('rejects malformed or unauthenticated bundles before touching the database', async() => {
    // risk: data integrity — a manifest whose hash does not authenticate its chunk list must never be stored.
    const remote = bundle({ path: 'remote/bad.txt' });
    expect(await prepare({ ...remote, file: { ...remote.file, id: 'nope' } })).toMatchObject({ status: 400, body: { error: 'valid file and version ids are required' } });
    expect(await prepare({ ...remote, manifest: { ...remote.manifest, hash: 'f'.repeat(64) } })).toMatchObject({ status: 400, body: { error: 'manifest hash does not authenticate its chunk list' } });
    expect(await prepare({ ...remote, chunks: [] })).toMatchObject({ status: 400, body: { error: 'chunk metadata must exactly match the manifest' } });
    expect(await prepare({ ...remote, version: { ...remote.version, size: 3 } })).toMatchObject({ status: 400, body: { error: 'manifest and version sizes do not match' } });
  });

  it('prepare reports missing chunks until they are uploaded, then commit stores the version once', async() => {
    // risk: data integrity — a version must never commit while its chunks are missing; replays must be idempotent.
    const remote = bundle({ path: 'remote/one.txt' });
    expect(await prepare(remote)).toMatchObject({ status: 200, body: { missing: remote.manifest.chunk_ids, currentVersionId: null, canonicalFileId: remote.file.id, conflict: false } });
    expect(await commit(remote)).toMatchObject({ status: 400, body: { error: 'manifest chunks missing', missing: remote.manifest.chunk_ids } });
    await uploadChunks(remote);
    expect((await prepare(remote)).body.missing).toEqual([]);
    expect(await commit(remote)).toMatchObject({ status: 200, body: { ok: true, versionId: remote.version.id, fileId: remote.file.id } });
    const file = (await fixture.pool.query('SELECT current_version_id,path,size,created_by_type FROM files WHERE id=$1', [remote.file.id])).rows[0];
    expect(file).toMatchObject({ current_version_id: remote.version.id, path: 'remote/one.txt', created_by_type: 'user' });
    expect((await fixture.pool.query('SELECT refcount FROM chunks WHERE collection_id=$1 AND id=$2', [fixture.collectionId, remote.chunks[0].id])).rows[0].refcount).toBe(1);
    const journal = async() => (await fixture.pool.query("SELECT count(*)::int AS n FROM journal WHERE file_id=$1 AND op='put'", [remote.file.id])).rows[0].n;
    expect(await journal()).toBe(1);
    // An identical replay is accepted without a second version, journal entry or chunk reference.
    expect(await commit(remote)).toMatchObject({ status: 200, body: { ok: true, versionId: remote.version.id } });
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM file_versions WHERE file_id=$1', [remote.file.id])).rows[0].n).toBe(1);
    expect(await journal()).toBe(1);
    expect((await fixture.pool.query('SELECT refcount FROM chunks WHERE collection_id=$1 AND id=$2', [fixture.collectionId, remote.chunks[0].id])).rows[0].refcount).toBe(1);
    // The same version id with different geometry is refused.
    const tampered = bundle({ fileId: remote.file.id, versionId: remote.version.id, path: 'remote/one.txt', size: 12 }); await uploadChunks(tampered);
    expect(await commit(tampered)).toMatchObject({ status: 409, body: { error: 'immutable remote version geometry does not match the requested version' } });
  });

  it('answers a stale base with a conflict and advances on the current base', async() => {
    // risk: data loss — a remote write based on an old version must not overwrite a newer one.
    const first = bundle({ path: 'remote/two.txt' }); await uploadChunks(first);
    expect((await commit(first)).status).toBe(200);
    const stale = bundle({ fileId: first.file.id, path: 'remote/two.txt', base: randomUUID() }); await uploadChunks(stale);
    expect(await commit(stale)).toMatchObject({ status: 409, body: { conflict: true, currentVersionId: first.version.id } });
    expect(await prepare(stale)).toMatchObject({ status: 200, body: { conflict: true, currentVersionId: first.version.id } });
    const next = bundle({ fileId: first.file.id, path: 'remote/two.txt', base: first.version.id }); await uploadChunks(next);
    expect(await commit(next)).toMatchObject({ status: 200, body: { versionId: next.version.id } });
    expect((await fixture.pool.query('SELECT parent_version_id FROM file_versions WHERE id=$1', [next.version.id])).rows[0].parent_version_id).toBe(first.version.id);
  });

  it('refuses a purged file identity and another file\'s path', async() => {
    // risk: data integrity — purged identities must not resurrect; one path holds one file.
    const purged = bundle({ path: 'remote/purged.txt' });
    await fixture.pool.query('INSERT INTO file_purge_tombstones(collection_id,file_id,path,lifecycle_generation) VALUES($1,$2,$3,1)', [fixture.collectionId, purged.file.id, purged.file.path]);
    expect(await prepare(purged)).toMatchObject({ status: 410, body: { error: 'file was permanently purged; create a new file identity to restore content' } });
    const owner = bundle({ path: 'remote/taken.txt' }); await uploadChunks(owner); expect((await commit(owner)).status).toBe(200);
    const mover = bundle({ path: 'remote/mover.txt' }); await uploadChunks(mover); expect((await commit(mover)).status).toBe(200);
    expect(await prepare(bundle({ fileId: mover.file.id, path: 'remote/taken.txt', base: mover.version.id }))).toMatchObject({ status: 409, body: { error: 'another file already exists at the requested path' } });
  });

  it('RemoteVersionBundleValidator accepts a deleted version only without a manifest', () => {
    // risk: data integrity — a tombstone version must carry no content.
    const validator = new RemoteVersionBundleValidator();
    const tombstone = { file: { id: randomUUID() }, version: { id: randomUUID(), deleted: true, size: 0 } };
    expect(validator.chunkMetadata(tombstone).size).toBe(0);
    expect(() => validator.chunkMetadata({ ...tombstone, version: { ...tombstone.version, deleted: false } })).toThrow('non-deleted versions require a manifest');
    const withManifest = bundle({ path: 'x.txt' });
    expect(() => validator.chunkMetadata({ ...withManifest, version: { ...withManifest.version, deleted: true } })).toThrow('deleted versions cannot carry a manifest');
    expect([...validator.chunkMetadata(withManifest).keys()]).toEqual(withManifest.manifest.chunk_ids);
  });
});
