// SPDX-License-Identifier: GPL-2.0-or-later
// GET /v1/files/publish-requests must reach the publication route, not the GET /v1/files/:id file
// detail route registered by the same app (which once received "publish-requests" as a file id).
// Both blocks drive the real FilesApplication route registration over HTTP with real capability
// tokens. The first fakes only the pg pool (it records which handler's SQL ran); the second uses the
// shared real-Postgres fixture and skips unless SULLA_FILES_TEST_DATABASE_URL is set.
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FilesApplication } from '../src/app.js';
import { issueCapabilityToken } from '../src/auth.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

const FILE = '6c6bc5bd-80ee-492e-b090-1b2f2735dbc0';
const VERSION = '99786748-b1a9-4765-bfe7-5bd05e0f146b';
const PATH = 'Use Cases/agents/qa-chat-grok-20261117/agent.yaml';

describe('publish request listing route precedence (real app routing, recorded database)', () => {
  const signingKey = Buffer.alloc(32, 7);
  const statements:{ text:string; params:unknown[] }[] = [];
  const stored = [{ id: randomUUID(), file_id: FILE, version_id: VERSION, status: 'approved', requested_by: 'agent:qa', path: PATH, collection_id: randomUUID() }];
  const query = async(textOrConfig:any, values:unknown[] = []) => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : String(textOrConfig?.text ?? '');
    const params = typeof textOrConfig === 'string' ? values : (textOrConfig?.values ?? []);
    statements.push({ text, params });
    if (/FROM files_publish_requests r JOIN files f/.test(text)) {
      const rows = stored.filter(row => row.status === params[0] && (params[1] == null || row.file_id === params[1]));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const db:any = { query, connect: async() => ({ query, release: () => undefined }), on: () => undefined, end: async() => undefined };
  let application:FilesApplication;
  let server:Server;
  let base = '';

  const token = (claims:Record<string, string> = {}) => issueCapabilityToken({ sub: 'routes-user', device_id: 'test-device', scopes: ['files/*'], ...claims }, signingKey);
  const get = (path:string, bearer:string | null = token()) => new Promise<{ status:number; body:any }>((done, reject) => {
    const request = httpRequest(new URL(path, base), { headers: bearer ? { authorization: `Bearer ${ bearer }` } : {} }, response => {
      const parts:Buffer[] = []; response.on('data', part => parts.push(Buffer.from(part)));
      response.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let body:any = text; try { body = JSON.parse(text) } catch { /* not JSON */ } done({ status: response.statusCode ?? 500, body }) });
    });
    request.on('error', reject); request.end();
  });

  beforeAll(async() => {
    const config:any = { port: 0, databaseUrl: '', chunkRoot: '/nonexistent-chunks', dataRoot: '/nonexistent', filesRoot: '/nonexistent-files', caseInsensitiveRoot: false,
      capabilitySigningKey: signingKey, mode: 'desktop', deviceId: 'local-device', userId: 'routes-user', localToken: 'test-local', cloudUrl: '', paused: true, modelDir: '/nonexistent',
      fuseExperiment: true, keyring: { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) }, fileRoots: [] };
    application = new FilesApplication({ db, config });
    server = createServer(application.build());
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
    base = `http://127.0.0.1:${ address.port }`;
  });
  afterAll(async() => { application?.stop(); await new Promise(done => server ? server.close(done) : done(undefined)) });

  it('lists the approved request for the exact file through the publication route', async() => {
    statements.length = 0;
    const reply = await get(`/v1/files/publish-requests?status=approved&fileId=${ FILE }`);
    expect(reply.status).toBe(200);
    expect(reply.body.requests).toEqual([expect.objectContaining({ file_id: FILE, version_id: VERSION, status: 'approved', path: PATH })]);
    // "publish-requests" is never handed to a file lookup as an id.
    expect(statements.some(statement => statement.params.includes('publish-requests'))).toBe(false);
  });

  it('returns no requests for another file', async() => {
    const reply = await get(`/v1/files/publish-requests?status=approved&fileId=${ randomUUID() }`);
    expect(reply).toEqual({ status: 200, body: { requests: [] } });
  });

  it('still refuses an agent identity (403) and a missing credential (401)', async() => {
    expect((await get(`/v1/files/publish-requests?status=approved&fileId=${ FILE }`, token({ agent_id: 'qa-agent', job_id: 'job-1' }))).status).toBe(403);
    expect((await get(`/v1/files/publish-requests?status=approved&fileId=${ FILE }`, null)).status).toBe(401);
  });

  it('still sends a file id to the file detail route', async() => {
    statements.length = 0;
    const reply = await get(`/v1/files/${ FILE }`);
    expect(reply.status).toBe(404);
    expect(statements.some(statement => statement.params.includes(FILE))).toBe(true);
    expect(statements.some(statement => /files_publish_requests/.test(statement.text))).toBe(false);
  });
});

describe.skipIf(!databaseUrl)('publish request listing route precedence (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  let fileId = '';
  let versionId = '';
  let path = '';

  beforeAll(async() => {
    await fixture.start();
    path = 'Use Cases/agents/qa-route/agent.yaml';
    fileId = await fixture.createFile(path);
    versionId = (await fixture.request(`/v1/files/${ fileId }`)).body.current_version_id;
    const requested = await fixture.request(`/v1/files/${ fileId }/versions/${ versionId }/publish-request`, 'POST', { token: fixture.token({ agent_id: 'qa-agent', job_id: 'job-1' }), body: { reason: 'route order' } });
    expect(requested.status).toBe(202);
    expect((await fixture.request(`/v1/files/publish-requests/${ requested.body.id }/approve`, 'POST', { body: {} })).status).toBe(200);
  }, 60_000);
  afterAll(() => fixture.stop());

  it('lists the approved exact file version and path for a human', async() => {
    const reply = await fixture.request(`/v1/files/publish-requests?status=approved&fileId=${ fileId }`);
    expect(reply.status).toBe(200);
    expect(reply.body.requests).toEqual([expect.objectContaining({ file_id: fileId, version_id: versionId, status: 'approved', path })]);
  });

  it('keeps the file filter, agent refusal, credential check and file detail route', async() => {
    expect(await fixture.request(`/v1/files/publish-requests?status=approved&fileId=${ randomUUID() }`)).toMatchObject({ status: 200, body: { requests: [] } });
    expect((await fixture.request(`/v1/files/publish-requests?status=approved&fileId=${ fileId }`, 'GET', { token: fixture.token({ agent_id: 'qa-agent', job_id: 'job-1' }) })).status).toBe(403);
    expect((await fixture.request(`/v1/files/publish-requests?status=approved&fileId=${ fileId }`, 'GET', { token: null })).status).toBe(401);
    expect(await fixture.request(`/v1/files/${ fileId }`)).toMatchObject({ status: 200, body: { id: fileId, path } });
  });
});
