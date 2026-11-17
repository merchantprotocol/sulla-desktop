// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes CollectionSyncRoutes (with CollectionSyncRepository) and OriginalRevealRoutes, moved out
// of app.ts, on the real app and a real Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files collection, journal, version and original-reveal routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  let fileId = '';

  beforeAll(async() => { await fixture.start(); fileId = await fixture.createFile('journal/entry.txt') }, 30_000);
  afterAll(() => fixture.stop());

  const journal = (query = '') => fixture.request(`/v1/collections/${ fixture.collectionId }/journal${ query }`);

  it('lists only published collections with the caller\'s access', async() => {
    // risk: data accuracy — unpublished collections must never be listed.
    const listed = await fixture.request('/v1/collections');
    expect(listed.status).toBe(200);
    expect(listed.body.map((row:any) => row.id)).toEqual([fixture.collectionId]);
    expect(listed.body[0]).toMatchObject({ systemArea: null, access_role: 'manage', shared_folders: [], shared_files: [] });
  });

  it('registers synced knowledge collections once and refuses other kinds', async() => {
    // risk: CRUD — re-registering must not overwrite an existing collection.
    const id = randomUUID(); const collection = { id, name: 'Synced', kind: 'knowledge', encrypted_data_key: {}, dedup_key_ciphertext: {} };
    expect(await fixture.request('/v1/collections', 'POST', { body: { collection: { ...collection, kind: 'scratch' } } })).toMatchObject({ status: 400, body: { error: 'only knowledge syncs' } });
    expect(await fixture.request('/v1/collections', 'POST', { body: { collection } })).toMatchObject({ status: 200, body: { ok: true } });
    expect(await fixture.request('/v1/collections', 'POST', { body: { collection: { ...collection, name: 'Renamed' } } })).toMatchObject({ status: 200, body: { ok: true } });
    expect((await fixture.pool.query('SELECT name,home,owner_user_id FROM collections WHERE id=$1', [id])).rows[0]).toEqual({ name: 'Synced', home: 'synced', owner_user_id: fixture.userId });
  });

  it('enrolls an org collection idempotently, exposes it to the File Manager, and refuses view-only FUSE writes', async() => {
    // risk: permissions/data integrity — Cloud refreshes cannot duplicate a local enrollment or turn view into write access.
    const id=randomUUID();
    const body={orgId:'org-1',orgName:'Research / Labs',name:'Shared Notes',creatorUserId:'cloud-creator',level:'view'};
    expect(await fixture.request(`/v1/desktop/org-collections/${id}`,'PUT',{body})).toMatchObject({status:200,body:{id,workspace_scope:'organization',org_collection_level:'view'}});
    expect(await fixture.request(`/v1/desktop/org-collections/${id}`,'PUT',{body:{...body,name:'Updated name'}})).toMatchObject({status:200});
    expect((await fixture.pool.query('SELECT COUNT(*)::int AS count,owner_user_id,root_key_source,cloud_creator_user_id FROM collections WHERE id=$1 GROUP BY owner_user_id,root_key_source,cloud_creator_user_id',[id])).rows[0])
      .toEqual({count:1,owner_user_id:fixture.userId,root_key_source:'org',cloud_creator_user_id:'cloud-creator'});
    const catalog=await fixture.request('/v1/collections');
    expect(catalog.body.find((row:any)=>row.id===id)).toMatchObject({workspaceScope:'organization',orgId:'org-1',orgName:'Research / Labs',level:'view',access_role:'view'});
    expect((await fixture.request(`/v1/collections/${id}/journal`)).status).toBe(200);
    const tree=(await fixture.request('/v1/fuse/tree')).body;
    expect(tree.collections.find((row:any)=>row.id===id)?.tree_path).toBe('Organizations/Research _ Labs/Updated name');
    expect((await fixture.request(`/v1/fuse/files?collectionId=${id}&path=attempt.txt`,'POST',{body:Buffer.from('no'),headers:{'content-type':'application/octet-stream'}})).status).toBe(403);
    expect((await fixture.request(`/v1/desktop/org-collections/${id}/level`,'PATCH',{body:{level:'edit'}})).status).toBe(200);
    expect((await fixture.request(`/v1/fuse/files?collectionId=${id}&path=write.txt`,'POST',{body:Buffer.from('yes'),headers:{'content-type':'text/plain'}})).status).toBe(201);
    expect((await fixture.request(`/v1/desktop/org-collections/${id}`,'DELETE')).status).toBe(204);
    expect((await fixture.request('/v1/collections')).body.some((row:any)=>row.id===id)).toBe(false);
    expect((await fixture.pool.query('SELECT COUNT(*)::int AS count FROM collections WHERE id=$1',[id])).rows[0].count).toBe(1);
  });

  it('serves the change journal as entries, changed paths and a head sequence', async() => {
    // risk: data accuracy — sync clients that miss or replay journal entries diverge from the server.
    const entries = (await journal()).body;
    const put = entries.find((entry:any) => entry.file_id === fileId);
    expect(put).toMatchObject({ op: 'put', file: { id: fileId, path: 'journal/entry.txt' }, syncAuthority: { canEdit: true, canViewDraft: true } });
    const changes = (await journal('?changesOnly=true')).body;
    expect(changes.paths).toContain('journal/entry.txt');
    expect(changes.more).toBe(false);
    expect((await journal('?changesOnly=true&head=true')).body).toEqual({ seq: changes.seq, paths: [], more: false });
    expect((await journal(`?changesOnly=true&after=${ changes.seq }`)).body).toEqual({ seq: changes.seq, paths: [], more: false });
    expect((await journal(`?after=${ changes.seq }`)).body).toEqual([]);
  });

  it('returns a version bundle by id and 404s for unknown versions or missing recording metadata', async() => {
    // risk: data accuracy — the bundle must describe exactly the requested version.
    const versionId = (await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [fileId])).rows[0].current_version_id;
    const bundle = await fixture.request(`/v1/versions/${ versionId }`);
    expect(bundle).toMatchObject({ status: 200, body: { version: { id: versionId, file_id: fileId }, file: { id: fileId }, collection: { system_area: null } } });
    expect((await fixture.request(`/v1/versions/${ randomUUID() }`)).status).toBe(404);
    expect((await fixture.request(`/v1/files/${ fileId }/recording-metadata`)).status).toBe(404);
  });

  it('allows original reveal only for the native main identity and maps failures without caching', async() => {
    // risk: permissions — an agent identity must never reveal originals on disk.
    const agent = await fixture.request('/v1/original-reveal/attest', 'POST', { body: { fileId }, token: fixture.token({ agent_id: 'agent-1', job_id: 'job-1' }) });
    expect(agent).toMatchObject({ status: 403, body: { error: 'Native main identity required', code: 'original-forbidden' } });
    expect(agent.headers['cache-control']).toBe('no-store');
    const noSecret = await fixture.request('/v1/original-reveal/attest', 'POST', { body: { fileId }, headers: { 'x-sulla-files-token': 'wrong' } });
    expect(noSecret).toMatchObject({ status: 403, body: { code: 'original-forbidden' } });
    expect((await fixture.request('/v1/original-reveal/redeem', 'POST', { body: { token: 'forged' } })).headers['cache-control']).toBe('no-store');
  });
});
