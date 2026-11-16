// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the chunk routes moved out of app.ts (ChunkRoutes: protected-chunk guard, GET/PUT
// /v1/chunks/:collection/:id with read/write authorization) and ChunkAccessRepository, on the real app
// and a real Postgres. Written against the inline app.ts handlers before the move.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ChunkAccessRepository } from '../src/Repositories/ChunkAccessRepository.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files chunk routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  let fileId = ''; let versionId = ''; let chunkId = ''; let storedSize = 0;
  const otherChunk = 'a'.repeat(64);

  beforeAll(async() => {
    await fixture.start();
    fileId = await fixture.createFile('chunks/one.txt');
    const row = (await fixture.pool.query(`SELECT v.id,m.chunk_ids->>0 AS chunk_id,c.stored_size FROM files f JOIN file_versions v ON v.id=f.current_version_id
      JOIN manifests m ON m.hash=v.manifest_hash JOIN chunks c ON c.collection_id=v.chunk_collection_id AND c.id=m.chunk_ids->>0 WHERE f.id=$1`, [fileId])).rows[0];
    ({ id: versionId, chunk_id: chunkId } = row); storedSize = Number(row.stored_size);
  }, 30_000);
  afterAll(() => fixture.stop());

  const chunkPath = (id:string, collectionId = fixture.collectionId) => `/v1/chunks/${ collectionId }/${ id }`;

  it('serves a chunk only to a caller who can view a file that references it', async() => {
    // risk: permissions — a deduplicated chunk id must never be a bearer capability.
    const read = await fixture.request(chunkPath(chunkId));
    expect(read.status).toBe(200);
    expect(read.headers['content-type']).toBe('application/octet-stream');
    expect(Number(read.headers['content-length'])).toBe(storedSize);
    expect(await fixture.request(chunkPath(otherChunk))).toMatchObject({ status: 403, body: { error: 'access denied' } });
    expect((await fixture.request(chunkPath(chunkId), 'GET', { token: null })).status).toBe(401);
  });

  it('accepts an editor\'s chunk upload and refuses an unknown collection', async() => {
    // risk: data integrity — an editor's chunk must land; a write to a collection the caller cannot see must not.
    const payload = Buffer.alloc(storedSize, 9);
    expect((await fixture.request(chunkPath(otherChunk), 'PUT', { body: payload, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(204);
    expect((await fixture.request(chunkPath(otherChunk, fixture.unpublishedCollectionId), 'PUT', { body: payload, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(404);
  });

  it('refuses every method on a protected chunk before authorization', async() => {
    // risk: permissions — vault/keychain chunks must never be readable or overwritable through the API.
    await fixture.pool.query('INSERT INTO files_protected_chunks(collection_id,chunk_id) VALUES($1,$2)', [fixture.collectionId, chunkId]);
    try {
      expect(await fixture.request(chunkPath(chunkId))).toMatchObject({ status: 403, body: { error: 'Protected system file' } });
      expect(await fixture.request(chunkPath(chunkId), 'PUT', { body: Buffer.alloc(4), headers: { 'content-type': 'application/octet-stream' } })).toMatchObject({ status: 403, body: { error: 'Protected system file' } });
    } finally { await fixture.pool.query('DELETE FROM files_protected_chunks WHERE collection_id=$1 AND chunk_id=$2', [fixture.collectionId, chunkId]) }
    expect((await fixture.request(chunkPath(chunkId))).status).toBe(200);
  });

  it('ChunkAccessRepository finds referencing versions and live upload intents for one principal scope', async() => {
    // risk: permissions — scoped uploads must match principal, scope and expiry exactly, newest first.
    const repository = new ChunkAccessRepository(fixture.pool);
    expect(await repository.isProtected(fixture.collectionId, chunkId)).toBe(false);
    expect((await repository.referencingFiles(fixture.collectionId, chunkId)).map(row => [row.id, row.version_id])).toEqual([[fileId, versionId]]);
    expect(await repository.referencingFiles(fixture.collectionId, otherChunk)).toEqual([]);
    const [live, older, expired, otherScope] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const insert = (version:string, scope:string, expires:string) => fixture.pool.query(`INSERT INTO file_share_chunk_uploads(file_id,target_collection_id,file_path,version_id,chunk_collection_id,chunk_id,principal_id,actor_scope,plain_size,expires_at)
      VALUES($1,$2,'chunks/one.txt',$3,$2,$4,$5,$6,11,NOW()+$7::interval)`, [fileId, fixture.collectionId, version, chunkId, fixture.userId, scope, expires]);
    await insert(live, 'device:d1', '20 minutes'); await insert(older, 'device:d1', '10 minutes'); await insert(expired, 'device:d1', '-1 minute'); await insert(otherScope, 'device:d2', '20 minutes');
    const intents = await repository.uploadIntents(fixture.collectionId, chunkId, fixture.userId, 'device:d1');
    expect(intents.map(row => row.version_id)).toEqual([live, older]);
    expect(intents[0]).toMatchObject({ file_id: fileId, target_collection_id: fixture.collectionId, file_path: 'chunks/one.txt', plain_size: expect.anything() });
    await repository.markUploaded([live, otherScope], chunkId, fixture.userId, 'device:d1');
    const uploaded = (await fixture.pool.query('SELECT version_id FROM file_share_chunk_uploads WHERE uploaded_at IS NOT NULL')).rows.map(row => row.version_id);
    expect(uploaded).toEqual([live]);
  });
});
