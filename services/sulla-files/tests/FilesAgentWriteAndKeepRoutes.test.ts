// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes agent writes (AgentWriteRoutes + AgentWriteRepository) and keeps (AgentKeepRoutes +
// AgentKeepRepository) moved out of app.ts, on the real app and a real Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files agent write and keep routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const job = (id = 'job-writer') => fixture.token({ job_id: id });
  const put = (body:Record<string, unknown>, token = job()) => fixture.request('/v1/agent-files', 'POST', { token, body: { collectionId: fixture.collectionId, mime: 'text/plain', ...body } });
  beforeAll(() => fixture.start(), 30_000);
  afterAll(() => fixture.stop());

  it('writes an agent artifact once per idempotency key and refuses a reused key with other content', async() => {
    // risk: duplicate writes / data accuracy — a retried agent write must replay, never fork history.
    const first = await put({ path: 'agent/idem.md', content: 'one', idempotencyKey: 'k1', message: 'Agent write' });
    expect(first).toMatchObject({ status: 201, body: { collectionId: fixture.collectionId, path: 'agent/idem.md' } });
    expect(await put({ path: 'agent/idem.md', content: 'one', idempotencyKey: 'k1', message: 'Agent write' })).toMatchObject({ status: 200, body: { fileId: first.body.fileId, versionId: first.body.versionId } });
    expect(await put({ path: 'agent/idem.md', content: 'two', idempotencyKey: 'k1', message: 'Agent write' })).toMatchObject({ status: 409, body: { error: 'idempotencyKey was already used for different content' } });
    expect(await put({ path: 'agent/idem.md', content: 'one', idempotencyKey: 'k1', message: 'other' })).toMatchObject({ status: 409, body: { error: 'idempotencyKey was already used with a different message' } });
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM file_versions WHERE file_id=$1', [first.body.fileId])).rows[0].n).toBe(1);
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE file_id=$1 AND action='put'", [first.body.fileId])).rows[0].n).toBe(1);
  });

  it('enforces the expected version, creator ownership and request validation', async() => {
    // risk: permissions / lost updates — one run must not overwrite another creator's artifact or a moved-on version.
    const written = await put({ path: 'agent/owned.md', content: 'mine' });
    expect(await put({ path: 'agent/owned.md', content: 'x', expectedVersionId: randomUUID() })).toMatchObject({ status: 409, body: { error: `file version conflict; current version is ${ written.body.versionId }` } });
    expect(await put({ path: 'agent/owned.md', content: 'x' }, job('job-thief'))).toMatchObject({ status: 409, body: { error: 'artifact path belongs to another creator' } });
    expect(await put({ path: 'agent/owned.md', content: 'x', fileId: 'nope' })).toMatchObject({ status: 400, body: { error: 'valid fileId required' } });
    expect(await put({ path: 'agent/owned.md', content: 'x', idempotencyKey: ' ' })).toMatchObject({ status: 400, body: { error: 'idempotencyKey must be 1 to 512 characters' } });
    const next = await put({ path: 'agent/owned.md', content: 'mine 2', expectedVersionId: written.body.versionId });
    expect(next).toMatchObject({ status: 201, body: { fileId: written.body.fileId } });
    expect((await fixture.pool.query('SELECT parent_version_id FROM file_versions WHERE id=$1', [next.body.versionId])).rows[0].parent_version_id).toBe(written.body.versionId);
  });

  it('records derived-from sources and replaces them on the next write', async() => {
    // risk: data accuracy — provenance edges must match the latest write exactly.
    const a = await fixture.createFile('sources/a.txt'); const b = await fixture.createFile('sources/b.txt');
    const written = await put({ path: 'agent/derived.md', content: 'd', derivedFrom: [b, a, a, 7] });
    const edges = async() => (await fixture.pool.query("SELECT dst_id FROM edges WHERE src_id=$1 AND kind='derived_from' ORDER BY dst_id", [written.body.fileId])).rows.map(row => row.dst_id);
    expect((await edges()).sort()).toEqual([a, b].sort());
    await put({ path: 'agent/derived.md', content: 'd2', derivedFrom: [a] });
    expect(await edges()).toEqual([a]);
  });

  it('ensures a collection only for job identities', async() => {
    // risk: permissions — only an agent job may ask for its default collection.
    expect(await fixture.request('/v1/agent-files/ensure', 'POST', { body: {} })).toMatchObject({ status: 400, body: { error: 'job identity is required' } });
    expect(await fixture.request('/v1/agent-files/ensure', 'POST', { body: {}, token: job() })).toMatchObject({ status: 201, body: { collectionId: fixture.collectionId } });
  });

  it('keeps one agent file at a new path, trashing the source and recording provenance', async() => {
    // risk: irreversible write / data accuracy — the kept copy must carry the content and the run's provenance.
    const written = await put({ path: 'agent/keep-me.md', content: 'keep me' }, job('job-keep'));
    expect(await fixture.request(`/v1/agent-files/${ written.body.fileId }/keep`, 'POST', { body: { collectionId: fixture.collectionId, path: 'agent/keep-me.md' } })).toMatchObject({ status: 409, body: { error: 'The file is already kept at this path' } });
    const kept = await fixture.request(`/v1/agent-files/${ written.body.fileId }/keep`, 'POST', { body: { collectionId: fixture.collectionId, path: 'kept/keep-me.md' } });
    expect(kept).toMatchObject({ status: 200, body: { path: 'kept/keep-me.md', provenance: { type: 'agent-run', id: 'job-keep' } } });
    expect((await fixture.pool.query('SELECT deleted_at IS NOT NULL AS trashed FROM files WHERE id=$1', [written.body.fileId])).rows[0].trashed).toBe(true);
    expect((await fixture.pool.query("SELECT props FROM edges WHERE src_id=$1 AND kind='created_by' AND dst_id='job-keep'", [kept.body.id])).rows[0].props).toEqual({ keptFromCollectionId: fixture.collectionId, sourceFileId: written.body.fileId });
    expect((await fixture.request(`/v1/fuse/files/${ kept.body.id }/content`)).body).toBe('keep me');
  });

  it('keeps every live file of a scratch run and refuses scratch targets and unknown runs', async() => {
    // risk: irreversible write — a run keep moves each live file exactly once into the permanent collection.
    const runId = 'job-run-keep'; const scratchId = randomUUID();
    await fixture.pool.query(`INSERT INTO collections(id,owner_user_id,agent_run_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,$2,$3,'Scratch','scratch','desktop-only','{}','{}','{}',TRUE,FALSE,$4)`, [scratchId, fixture.userId, runId, `spec-${ scratchId }`]);
    for (const path of ['run/a.md', 'run/b.md']) expect((await fixture.request('/v1/agent-files', 'POST', { token: job(runId), body: { collectionId: scratchId, path, content: path, mime: 'text/plain' } })).status).toBe(201);
    expect(await fixture.request(`/v1/agent-runs/${ runId }/keep`, 'POST', { body: { collectionId: scratchId } })).toMatchObject({ status: 400, body: { error: 'Keep target must be a permanent collection' } });
    expect(await fixture.request('/v1/agent-runs/job-unknown/keep', 'POST', { body: { collectionId: fixture.collectionId } })).toMatchObject({ status: 404, body: { error: 'scratch run not found' } });
    expect(await fixture.request(`/v1/agent-runs/${ runId }/keep`, 'POST', { body: { collectionId: fixture.collectionId } })).toMatchObject({ status: 200, body: { count: 2 } });
    expect((await fixture.pool.query("SELECT path FROM files WHERE collection_id=$1 AND path LIKE 'run/%' AND deleted_at IS NULL ORDER BY path", [fixture.collectionId])).rows.map(row => row.path)).toEqual(['run/a.md', 'run/b.md']);
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM files WHERE collection_id=$1 AND deleted_at IS NULL', [scratchId])).rows[0].n).toBe(0);
  });
});
