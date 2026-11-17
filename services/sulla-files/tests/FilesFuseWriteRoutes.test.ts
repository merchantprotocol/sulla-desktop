// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the Files-mount write routes moved out of app.ts (FuseFileRoutes, FuseContentRoutes,
// FuseMetadataRoutes with FuseWriteRepository and FileMetadataRepository) on the real app and a real Postgres.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files mount write routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  beforeAll(() => fixture.start(), 30_000);
  afterAll(() => fixture.stop());
  const sha256 = (value:string) => createHash('sha256').update(value).digest('hex');
  const current = async(id:string) => (await fixture.pool.query('SELECT path,current_version_id,deleted_at FROM files WHERE id=$1', [id])).rows[0];
  const write = (id:string, version:string, base:string, next:string) => fixture.request(`/v1/fuse/files/${ id }/content`, 'PUT', {
    body: Buffer.from(next), headers: { 'content-type': 'text/plain', 'if-match': `"${ version }"`, 'x-sulla-source-hash': sha256(base) } });

  it('creates a file, revives a trashed path with its history and audits the create', async() => {
    // risk: data accuracy — recreating a deleted path must revive the same file, not fail or fork it.
    const id = await fixture.createFile('mount/revive.txt');
    const first = (await current(id)).current_version_id;
    expect((await fixture.request(`/v1/fuse/files/${ id }`, 'DELETE')).status).toBe(204);
    expect((await current(id)).deleted_at).not.toBeNull();
    expect((await fixture.createFile('mount/revive.txt'))).toBe(id);
    const revived = await current(id);
    expect(revived.deleted_at).toBeNull();
    // Trash appends a deleted 'Moved to Trash' tombstone on top of the first version; the revived version follows it.
    const parentOf = async(versionId:string) => (await fixture.pool.query('SELECT parent_version_id,deleted,message FROM file_versions WHERE id=$1', [versionId])).rows[0];
    const tombstoneId = (await parentOf(revived.current_version_id)).parent_version_id;
    expect(await parentOf(tombstoneId)).toEqual({ parent_version_id: first, deleted: true, message: 'Moved to Trash' });
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE file_id=$1 AND action='fuse-create'", [id])).rows[0].n).toBe(2);
  });

  it('writes content against the current version, merges a stale text base and replays a committed retry', async() => {
    // risk: lost updates / duplicate versions — mount writes must be version-checked and idempotent on retry.
    const id = await fixture.createFile('mount/edit.txt'); const v1 = (await current(id)).current_version_id;
    expect(await fixture.request(`/v1/fuse/files/${ id }/content`, 'PUT', { body: Buffer.from('x'), headers: { 'content-type': 'text/plain' } })).toMatchObject({ status: 428 });
    const saved = await write(id, v1, 'body of mount/edit.txt', 'line one\nbody of mount/edit.txt');
    expect(saved.status).toBe(200);
    expect(saved.headers.etag).toBe(`"${ saved.body.versionId }"`);
    expect(saved.body).toMatchObject({ id, path: 'mount/edit.txt', sourceHash: sha256('line one\nbody of mount/edit.txt') });
    const replay = await write(id, v1, 'body of mount/edit.txt', 'line one\nbody of mount/edit.txt');
    expect(replay.body.versionId).toBe(saved.body.versionId);
    const merged = await write(id, v1, 'body of mount/edit.txt', 'body of mount/edit.txt\nline two');
    expect(merged.status).toBe(200);
    expect(merged.headers['x-sulla-merged']).toBe('1');
    expect((await fixture.request(`/v1/fuse/files/${ id }/content`)).body).toBe('line one\nbody of mount/edit.txt\nline two');
    expect(await write(id, v1, 'not the base', 'z')).toMatchObject({ status: 409, body: { error: 'Files mount version changed' } });
  });

  // risk: data loss — failure of the optional request-audit dual-write must not roll back a successful file version.
  it('commits the file version and durable spool row when audit_log rejects its dual-write', async() => {
    const id = await fixture.createFile('mount/audit-failure.txt');
    const initial = (await current(id)).current_version_id;
    await fixture.pool.query("ALTER TABLE audit_log ADD CONSTRAINT reject_fuse_write_audit CHECK (action <> 'fuse-write') NOT VALID");
    try {
      const saved = await write(id, initial, 'body of mount/audit-failure.txt', 'updated despite audit failure');
      expect(saved.status).toBe(200);
      expect(saved.body.versionId).not.toBe(initial);
      expect(await current(id)).toMatchObject({ path: 'mount/audit-failure.txt', current_version_id: saved.body.versionId });
      expect((await fixture.request(`/v1/fuse/files/${ id }/content`)).body).toBe('updated despite audit failure');
      expect((await fixture.pool.query('SELECT count(*)::int AS n FROM file_versions WHERE id=$1 AND file_id=$2', [saved.body.versionId, id])).rows[0].n).toBe(1);
      expect((await fixture.pool.query("SELECT count(*)::int AS n FROM files_audit_spool WHERE event->>'subjectId'=$1 AND event->>'action'='write'", [id])).rows[0].n).toBeGreaterThan(0);
    } finally {
      await fixture.pool.query('ALTER TABLE audit_log DROP CONSTRAINT reject_fuse_write_audit');
    }
  });

  it('streams a version-checked write and enforces its headers', async() => {
    // risk: data accuracy — a streamed write must commit exactly the declared bytes on the expected base.
    const id = await fixture.createFile('mount/stream.txt'); const v1 = (await current(id)).current_version_id;
    const stream = (headers:Record<string, string>, body = Buffer.from('streamed')) => fixture.request(`/v1/fuse/files/${ id }/content/stream`, 'PUT', { body, headers });
    expect((await stream({})).status).toBe(428);
    const written = await stream({ 'if-match': `"${ v1 }"`, 'x-sulla-source-hash': sha256('body of mount/stream.txt') });
    expect(written).toMatchObject({ status: 200, body: { id, sourceHash: sha256('streamed') } });
    expect(Number(written.body.size)).toBe(8);
    expect((await fixture.request(`/v1/fuse/files/${ id }/content`)).body).toBe('streamed');
    expect((await stream({ 'if-match': `"${ v1 }"`, 'x-sulla-source-hash': sha256('body of mount/stream.txt') })).status).toBe(409);
  });

  /** Bumps the file's operation_revision right after the route's unlocked row read, as a settling rename does. */
  const bumpAfterRowRead = (id:string, times:number) => {
    const original = fixture.pool.query.bind(fixture.pool) as (...args:any[]) => Promise<any>;
    const state = { bumps: 0 };
    const spy = vi.spyOn(fixture.pool, 'query').mockImplementation((async(...args:any[]) => {
      const result = await original(...args);
      if (state.bumps < times && args[0] === 'SELECT * FROM files WHERE id=$1' && args[1]?.[0] === id) {
        state.bumps++;
        await fixture.admin.query(`UPDATE "${ fixture.schema }".files SET operation_revision=operation_revision+1 WHERE id=$1`, [id]);
      }
      return result;
    }) as any);
    return { state, restore: () => spy.mockRestore() };
  };

  it('retries a mount rename when the row moves between its read and the locked check', async() => {
    // risk: data accuracy — `mv a b; mv b sub/c` failed EPERM (409 'The selected file changed') on the iMac soak.
    const id = await fixture.createFile('mount/race-a.txt');
    const race = bumpAfterRowRead(id, 1);
    try {
      expect(await fixture.request(`/v1/fuse/files/${ id }`, 'PATCH', { body: { path: 'mount/race-c.txt' } })).toMatchObject({ status: 200 });
    } finally { race.restore() }
    expect(race.state.bumps).toBe(1);
    expect((await current(id)).path).toBe('mount/race-c.txt');
  });

  it('gives up with 409 and leaves the file in place when the row keeps changing', async() => {
    // risk: availability — the retry must be bounded, and a refused move must not move anything.
    const id = await fixture.createFile('mount/race-busy.txt');
    const race = bumpAfterRowRead(id, 100);
    try {
      expect(await fixture.request(`/v1/fuse/files/${ id }`, 'PATCH', { body: { path: 'mount/race-busy-2.txt' } })).toMatchObject({ status: 409 });
    } finally { race.restore() }
    expect(race.state.bumps).toBe(4);
    expect((await current(id)).path).toBe('mount/race-busy.txt');
  });

  it('renames files, creates described folders and removes only empty ones', async() => {
    // risk: data accuracy — namespace moves and removals must never drop live files.
    const id = await fixture.createFile('mount/old-name.txt');
    expect(await fixture.request(`/v1/fuse/files/${ id }`, 'PATCH', { body: { path: 'mount/new-name.txt' } })).toMatchObject({ status: 200 });
    expect((await current(id)).path).toBe('mount/new-name.txt');
    const folder = await fixture.request('/v1/fuse/folders', 'POST', { body: { collectionId: fixture.collectionId, path: 'mount/fresh/inner' }, token: fixture.token({ agent_id: 'agent-x', job_id: 'job-x' }) });
    expect(folder).toMatchObject({ status: 201, body: { path: 'mount/fresh/inner', needsDescription: true } });
    expect(folder.body.description).toMatch(/^Created by agent-x on \d{4}-\d{2}-\d{2} — needs description$/);
    expect((await fixture.pool.query("SELECT description FROM file_folders WHERE collection_id=$1 AND path='mount/fresh'", [fixture.collectionId])).rows[0].description).toBe(folder.body.description);
    expect(await fixture.request(`/v1/fuse/folders?collectionId=${ fixture.collectionId }&path=mount`, 'DELETE')).toMatchObject({ status: 409, body: { error: 'folder is not empty' } });
    expect((await fixture.request(`/v1/fuse/folders?collectionId=${ fixture.collectionId }&path=mount/fresh`, 'DELETE')).status).toBe(204);
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM file_folders WHERE collection_id=$1 AND path LIKE 'mount/fresh%'", [fixture.collectionId])).rows[0].n).toBe(0);
  });

  it('replaces a file with another file\'s content and trashes the source', async() => {
    // risk: irreversible write — replace must carry the source bytes and retire the source exactly once.
    const target = await fixture.createFile('mount/target.bin'); const source = await fixture.createFile('mount/source.bin');
    expect(await fixture.request(`/v1/fuse/files/${ target }/replace`, 'POST', { body: { sourceFileId: target } })).toMatchObject({ status: 400, body: { error: 'replacement source must differ from target' } });
    const replaced = await fixture.request(`/v1/fuse/files/${ target }/replace`, 'POST', { body: { sourceFileId: source } });
    expect(replaced).toMatchObject({ status: 200, body: { id: target, path: 'mount/target.bin' } });
    expect((await fixture.request(`/v1/fuse/files/${ target }/content`)).body).toBe('body of mount/source.bin');
    expect((await current(source)).deleted_at).not.toBeNull();
  });

  it('writes revision-checked metadata, audits each changed key and lists a folder\'s child metadata', async() => {
    // risk: permissions / data accuracy — agents may not set approval fields; stale revisions are refused.
    await fixture.createFile('meta/doc.txt');
    const put = (body:Record<string, unknown>, token?:string) => fixture.request('/v1/fuse/metadata', 'PUT', { body: { collectionId: fixture.collectionId, path: 'meta/doc.txt', ...body }, ...(token ? { token } : {}) });
    expect(await put({ set: { status: 'draft' } })).toMatchObject({ status: 200, body: { revision: 1, metadata: { status: 'draft' } } });
    expect(await put({ set: { status: 'final' }, baseRevision: 0 })).toMatchObject({ status: 409, body: { error: 'metadata revision changed' } });
    expect(await put({ set: { approvedBy: 'x' } }, fixture.token({ agent_id: 'agent-m', job_id: 'job-m' }))).toMatchObject({ status: 403 });
    expect(await put({ unset: ['status'], set: { owner: 'me' }, baseRevision: 1 })).toMatchObject({ status: 200, body: { revision: 2, metadata: { owner: 'me' } } });
    expect((await fixture.pool.query("SELECT details->>'key' AS key FROM audit_log WHERE action='metadata-set' AND details->>'path'='meta/doc.txt' ORDER BY id", [])).rows.map(row => row.key)).toEqual(['status', 'owner', 'status']);
    // Regression: the child-listing offset must bind as an integer (substring(path from $3::int)); untyped it resolved
    // to the regex form substring(text,text) and every child was filtered out. Grandchildren and bare files stay out.
    await fixture.createFile('meta/plain.txt');
    await fixture.createFile('meta/sub/deep.txt');
    expect((await fixture.request('/v1/fuse/metadata', 'PUT', { body: { collectionId: fixture.collectionId, path: 'meta/sub/deep.txt', set: { owner: 'deep' } } })).status).toBe(200);
    const listed = await fixture.request(`/v1/fuse/folder-metadata?collectionId=${ fixture.collectionId }&path=meta`);
    expect(listed.status).toBe(200);
    expect(listed.body.files).toEqual({ 'doc.txt': { owner: 'me' } });
    expect(await fixture.request(`/v1/fuse/folder-metadata?collectionId=${ fixture.collectionId }&path=meta/doc.txt`)).toMatchObject({ status: 400, body: { error: 'path is not a folder' } });
    expect(await fixture.request(`/v1/fuse/metadata?collectionId=${ fixture.collectionId }&path=meta/missing.txt`)).toMatchObject({ status: 404, body: { error: 'Files path not found' } });
  });
});
