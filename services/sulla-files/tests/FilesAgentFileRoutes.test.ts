// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the agent-file read routes moved out of app.ts (AgentFileRoutes: run inventory query,
// Use Case home collection, agent file read, file edges, run end) with AgentFileRepository, on the real
// app and a real Postgres. Written against the inline app.ts handlers before the move.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentFileRepository } from '../src/Repositories/AgentFileRepository.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files agent-file routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const runId = 'job-agent-files'; const otherRunId = 'job-other';
  const agent = () => fixture.token({ agent_id: 'agent-1', job_id: runId });
  let agentFileId = ''; let agentVersionId = ''; let userFileId = ''; let scratchId = '';

  const writeAgentFile = async(path:string, job:string, content:string) => {
    // A job-only token, as the run writer: app.ts insertVersion records a token carrying agent_id as created_by_type
    // 'agent', and the run inventory (like main) only matches created_by_type='agent-run' rows by run id.
    const written = await fixture.request('/v1/agent-files', 'POST', { token: fixture.token({ job_id: job }), body: { collectionId: fixture.collectionId, path, content, mime: 'text/plain' } });
    if (written.status !== 201) throw new Error(`agent write ${ path }: ${ written.status } ${ JSON.stringify(written.body) }`);
    return written.body as { fileId:string; versionId:string };
  };

  beforeAll(async() => {
    await fixture.start();
    ({ fileId: agentFileId, versionId: agentVersionId } = await writeAgentFile('runs/report.md', runId, '# report'));
    await writeAgentFile('runs/other.md', otherRunId, 'other run');
    const trashed = await writeAgentFile('runs/trashed.md', runId, 'gone');
    await fixture.pool.query('UPDATE files SET deleted_at=NOW() WHERE id=$1', [trashed.fileId]);
    userFileId = await fixture.createFile('docs/user.txt');
    scratchId = randomUUID();
    await fixture.pool.query(`INSERT INTO collections(id,owner_user_id,agent_run_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,$2,$3,'Scratch','scratch','desktop-only','{}','{}','{}',TRUE,FALSE,$4)`, [scratchId, fixture.userId, runId, `spec-${ scratchId }`]);
    await fixture.pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,'a.txt','agent-run',$2,'text/plain',1),($1,'b.txt','agent-run',$2,'text/plain',1)`, [scratchId, runId]);
    await fixture.pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,deleted_at) VALUES($1,'c.txt','agent-run',$2,'text/plain',1,NOW())`, [scratchId, runId]);
  }, 30_000);
  afterAll(() => fixture.stop());

  it('inventories one run\'s live files and validates the query body', async() => {
    // risk: tenant isolation/data accuracy — an agent's inventory must list only its own run's live files.
    const query = (body:unknown) => fixture.request('/v1/agent-files/query', 'POST', { body: body as object, token: agent() });
    expect(await query([])).toMatchObject({ status: 400, body: { error: 'valid JSON body required' } });
    expect(await query({ runIds: [] })).toMatchObject({ status: 200, body: [] });
    expect(await query({ runIds: [runId] })).toMatchObject({ status: 400, body: { error: 'threadId is required' } });
    const listed = await query({ runIds: [runId, runId, 7], threadId: 'thread-1' });
    expect(listed.status).toBe(200);
    expect(listed.body.map((row:any) => row.path)).toEqual(['runs/report.md']);
    expect(listed.body[0]).toMatchObject({ id: agentFileId, collection_kind: 'knowledge', agent_run_id: null, created_by_id: runId });
    expect(listed.body[0].search_text).toBeUndefined();
    expect((await query({ runIds: [otherRunId, runId], threadId: 'thread-1' })).body.map((row:any) => row.path).sort()).toEqual(['runs/other.md', 'runs/report.md']);
  });

  it('refuses run inventory over legacy external collections', async() => {
    // risk: data integrity — legacy external chunk stores must never be opened implicitly.
    await fixture.pool.query("UPDATE collections SET compatibility_state='legacy-external-data' WHERE id=$1", [fixture.collectionId]);
    try {
      expect(await fixture.request('/v1/agent-files/query', 'POST', { body: { runIds: [runId], threadId: 't' }, token: agent() })).toMatchObject({ status: 409, body: { error: expect.stringContaining('Legacy agent files need an explicit secure import') } });
    } finally { await fixture.pool.query("UPDATE collections SET compatibility_state='native' WHERE id=$1", [fixture.collectionId]) }
  });

  it('resolves the Use Case home collection to the published non-system collection', async() => {
    // risk: data accuracy — Use Case drafts must land in the user's home collection, not an unpublished one.
    expect(await fixture.request('/v1/agent-files/use-case-collection', 'GET', { token: agent() })).toMatchObject({ status: 200, body: { collectionId: fixture.collectionId } });
  });

  it('reads an agent file with its version and content, and 404s an unknown version', async() => {
    // risk: data accuracy — agents must read exactly the requested, non-deleted version.
    const read = await fixture.request(`/v1/agent-files/${ agentFileId }`, 'GET', { token: agent() });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ file: { id: agentFileId }, version: { id: agentVersionId, file_id: agentFileId } });
    expect(Buffer.from(read.body.content_base64, 'base64').toString('utf8')).toBe('# report');
    expect(await fixture.request(`/v1/agent-files/${ agentFileId }?versionId=${ randomUUID() }`, 'GET', { token: agent() })).toMatchObject({ status: 404, body: { error: 'file version not found' } });
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE file_id=$1 AND action='get'", [agentFileId])).rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('links two files once and refuses an unknown edge kind', async() => {
    // risk: data accuracy — duplicate edges would double-count relationships in file detail.
    const link = (kind:string) => fixture.request('/v1/file-edges', 'POST', { body: { fileId: userFileId, targetFileId: agentFileId, kind } });
    expect(await link('created_by')).toMatchObject({ status: 400, body: { error: 'invalid edge kind' } });
    expect((await link('links_to')).status).toBe(204);
    expect((await link('links_to')).status).toBe(204);
    const edges = (await fixture.pool.query("SELECT dst_id,kind,created_by FROM edges WHERE src_type='file' AND src_id=$1", [userFileId])).rows;
    expect(edges).toEqual([{ dst_id: agentFileId, kind: 'links_to', created_by: fixture.userId }]);
    expect((await fixture.request('/v1/file-edges', 'POST', { body: { fileId: randomUUID(), targetFileId: agentFileId, kind: 'links_to' } })).status).toBe(404);
  });

  it('ending a run schedules only that run\'s live scratch files to expire, once', async() => {
    // risk: irreversible side effect — only the ending run's scratch files may get a TTL.
    expect(await fixture.request(`/v1/agent-runs/${ runId }/end`, 'POST', { body: {}, token: agent() })).toMatchObject({ status: 200, body: { count: 2 } });
    const rows = (await fixture.pool.query('SELECT path,expires_at FROM files WHERE collection_id=$1 ORDER BY path', [scratchId])).rows;
    expect(rows.map(row => [row.path, row.expires_at !== null])).toEqual([['a.txt', true], ['b.txt', true], ['c.txt', false]]);
    const days = (rows[0].expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9); expect(days).toBeLessThanOrEqual(14);
    expect((await fixture.request(`/v1/agent-runs/${ runId }/end`, 'POST', { body: {}, token: agent() })).body).toEqual({ count: 0 });
    expect((await fixture.pool.query('SELECT expires_at FROM files WHERE id=$1', [agentFileId])).rows[0].expires_at).toBeNull();
  });

  it('AgentFileRepository finds a live version only for its own file', async() => {
    // risk: data accuracy — a version id from another file must never resolve.
    const repository = new AgentFileRepository(fixture.pool, 'f.id,f.path');
    expect((await repository.liveVersion(agentVersionId, agentFileId))?.id).toBe(agentVersionId);
    expect(await repository.liveVersion(agentVersionId, userFileId)).toBeUndefined();
  });
});
