// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes FolderGuidanceRoutes (moved out of app.ts) with FolderGuidanceRepository,
// CollectionSettingsRepository and the RequestAuditLog / AuditLogRepository dual-write,
// on the real app and a real Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files folder guidance and collection settings routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  let agentToken = '';

  beforeAll(async() => { await fixture.start(); agentToken = fixture.token({ agent_id: 'agent-1', job_id: 'job-1' }) }, 30_000);
  afterAll(() => fixture.stop());

  const createFolder = (body:object, token?:string) => fixture.request('/v1/folders', 'POST', { body: { collectionId: fixture.collectionId, ...body }, ...(token ? { token } : {}) });
  const folders = (query = '') => fixture.request(`/v1/folders?collectionId=${ fixture.collectionId }&details=true${ query }`);
  const auditActions = async(action:string) => (await fixture.pool.query('SELECT who_type,details FROM audit_log WHERE action=$1', [action])).rows;

  it('creates folders and records an audit row; agents must describe theirs and flag undescribed parents', async() => {
    // risk: data accuracy — agent-created folders without guidance make filing decisions unreviewable.
    expect(await createFolder({ path: 'notes' })).toMatchObject({ status: 201, body: { path: 'notes', description: null, needsDescription: false } });
    expect(await auditActions('create-folder')).toEqual([expect.objectContaining({ details: expect.objectContaining({ folderPath: 'notes' }) })]);
    expect(await createFolder({ path: 'projects/alpha' }, agentToken)).toMatchObject({ status: 400, body: { error: 'description is required when an agent creates a folder' } });
    expect((await createFolder({ path: 'projects/alpha', description: 'Alpha launch plans', namingHint: 'yyyy-mm-dd-topic.md' }, agentToken)).status).toBe(201);
    const listed = (await folders()).body;
    expect(listed.map((row:any) => row.path)).toEqual(['notes', 'projects', 'projects/alpha']);
    expect(listed.find((row:any) => row.path === 'projects')).toMatchObject({ needsDescription: true, description: expect.stringMatching(/^Created by agent-1 on \d{4}-\d{2}-\d{2} — needs description$/) });
    expect(listed.find((row:any) => row.path === 'projects/alpha')).toMatchObject({ needsDescription: false, description: 'Alpha launch plans', namingHint: 'yyyy-mm-dd-topic.md' });
  });

  it('pages folder listings and requires a collection', async() => {
    // risk: data accuracy — a paged folder listing must not skip or repeat folders.
    expect(await fixture.request('/v1/folders')).toMatchObject({ status: 400, body: { error: 'collectionId is required' } });
    const first = await fixture.request(`/v1/folders?collectionId=${ fixture.collectionId }&limit=2`);
    expect(first.body).toEqual(['notes', 'projects']);
    expect(first.headers['x-has-more']).toBe('true');
    const second = await fixture.request(`/v1/folders?collectionId=${ fixture.collectionId }&limit=2&cursor=${ first.headers['x-next-cursor'] }`);
    expect(second.body).toEqual(['projects/alpha']);
  });

  it('updates folder guidance and refuses unknown folders', async() => {
    // risk: CRUD — the guidance update must land on the right folder and clear needsDescription.
    const projects = (await folders()).body.find((row:any) => row.path === 'projects');
    const updated = await fixture.request(`/v1/folders/${ projects.folderId }/description`, 'PATCH', { body: { description: 'All client projects' } });
    expect(updated).toMatchObject({ status: 200, body: { folderId: projects.folderId, path: 'projects', description: 'All client projects', namingHint: null, needsDescription: false } });
    expect((await fixture.request(`/v1/folders/${ randomUUID() }/description`, 'PATCH', { body: { description: 'x' } })).status).toBe(404);
    expect((await fixture.request(`/v1/folders/${ projects.folderId }/description`, 'PATCH', { body: { description: 'x'.repeat(2001) } })).status).toBe(400);
  });

  it('changes collection guidance and keep-on-computer, validating the flag', async() => {
    // risk: CRUD — a non-boolean flag must never flip keep-on-computer.
    expect(await fixture.request(`/v1/collections/${ fixture.collectionId }/description`, 'PATCH', { body: { description: 'Company files', namingHint: 'kebab-case' } }))
      .toMatchObject({ status: 200, body: { id: fixture.collectionId, description: 'Company files', namingHint: 'kebab-case' } });
    expect((await fixture.request(`/v1/collections/${ fixture.collectionId }/keep-on-computer`, 'PATCH', { body: { enabled: 'yes' } })).status).toBe(400);
    expect(await fixture.request(`/v1/collections/${ fixture.collectionId }/keep-on-computer`, 'PATCH', { body: { enabled: true } })).toMatchObject({ status: 200, body: { id: fixture.collectionId, keepOnComputer: true } });
    expect((await auditActions('change-collection-keep-on-computer')).length).toBe(1);
  });

  it('suggests where a new file goes from folder and collection guidance', async() => {
    // risk: business logic — agents file documents where the best-matching described folder says.
    expect((await fixture.request('/v1/folders/where')).status).toBe(400);
    const where = await fixture.request('/v1/folders/where?what=alpha%20launch&kind=markdown');
    expect(where.status).toBe(200);
    expect(where.body.suggestedFolder).toMatchObject({ collectionId: fixture.collectionId, path: 'projects/alpha' });
    expect(where.body).toMatchObject({ suggestedFilename: 'alpha-launch.md', suggestedPath: 'projects/alpha/alpha-launch.md' });
    const map = (await fixture.request('/v1/folders/map')).body;
    expect(map.map((row:any) => row.path)).toEqual(expect.arrayContaining(['', 'projects', 'projects/alpha']));
  });
});
