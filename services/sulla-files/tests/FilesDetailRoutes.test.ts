// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the file read routes moved out of app.ts (FileFeedRoutes: recent/stats/folder summary;
// FileDetailRoutes: detail/preview/download/thumbnail/history) with FileDetailRepository, on the real app
// and a real Postgres. Written against the inline app.ts handlers before the move.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FileDetailRepository } from '../src/Repositories/FileDetailRepository.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files detail, preview and feed routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const files:Record<string, string> = {};

  beforeAll(async() => {
    await fixture.start();
    for (const path of ['notes/alpha.txt', 'notes/beta.txt', 'notes/deep/gamma.txt', 'misc/trashed.txt']) files[path] = await fixture.createFile(path);
    await fixture.pool.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,'links_to','spec'),('file',$3,'file',$1,'derived_from','spec'),('file',$1,'file',$4,'links_to','spec')`,
      [files['notes/alpha.txt'], files['notes/beta.txt'], files['notes/deep/gamma.txt'], randomUUID()]);
    expect((await fixture.request(`/v1/fuse/files/${ files['misc/trashed.txt'] }`, 'DELETE')).status).toBe(204);
  }, 30_000);
  afterAll(() => fixture.stop());

  const alpha = () => files['notes/alpha.txt'];

  it('returns file detail with its visible version, both link directions and recent activity', async() => {
    // risk: permissions/data accuracy — links must only expose files the caller can view; version must be the current one.
    const detail = await fixture.request(`/v1/files/${ alpha() }`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: alpha(), path: 'notes/alpha.txt', provenance: { type: expect.any(String) }, recording: null, access: { role: expect.any(String), inherited: [] }, capabilities: expect.any(Object) });
    expect(detail.body.version).toMatchObject({ id: detail.body.current_version_id, file_id: alpha(), size: String('body of notes/alpha.txt'.length) });
    expect(detail.body.search_text).toBeUndefined();
    const links = detail.body.links.map((link:any) => [link.id, link.kind, link.direction]).sort();
    // The edge to a missing file is hidden: a relationship never grants access to its other endpoint.
    expect(links).toEqual([[files['notes/beta.txt'], 'links_to', 'outgoing'], [files['notes/deep/gamma.txt'], 'derived_from', 'incoming']].sort());
    expect(Array.isArray(detail.body.activity)).toBe(true);
  });

  it('shows the published model conflict and exact version without exposing other audit messages', async() => {
    const versionId = (await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [alpha()])).rows[0].current_version_id;
    const message = 'The owner chose shared routing. Update the agent or file to reconcile its model settings.';
    await fixture.pool.query(`INSERT INTO audit_log(who_type,who_id,file_id,version_id,action,details)
      VALUES ('user',$1,$2,$3,'use-case-model-conflict',$4),('user',$1,$2,$3,'test-unrelated-action','{"message":"do not expose"}')`,
    [fixture.userId, alpha(), versionId, { message }]);
    const detail = await fixture.request(`/v1/files/${ alpha() }`);
    expect(detail.status).toBe(200);
    expect(detail.body.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'use-case-model-conflict', message, version_id: versionId }),
      expect.objectContaining({ action: 'test-unrelated-action', message: null, version_id: null }),
    ]));
    expect((await new FileDetailRepository(fixture.pool).activity(alpha())).map(row => row.action)).not.toContain('use-case-model-conflict');
  });

  it('keeps trashed-file detail without a version, and 404s an unknown file', async() => {
    // risk: data accuracy — a trashed file's tombstone must not broaden version visibility.
    const trashed = await fixture.request(`/v1/files/${ files['misc/trashed.txt'] }`);
    expect(trashed.status).toBe(200);
    expect(trashed.body).toMatchObject({ id: files['misc/trashed.txt'], version: null, recording: null });
    expect(trashed.body.deleted_at).not.toBeNull();
    expect(await fixture.request(`/v1/files/${ randomUUID() }`)).toMatchObject({ status: 404, body: { error: 'file not found' } });
    expect((await fixture.request(`/v1/files/${ alpha() }`, 'GET', { token: null })).status).toBe(401);
  });

  it('previews full and ranged content, rejects unsatisfiable ranges and audits each read', async() => {
    // risk: data accuracy — byte ranges feed the media player and the mount; wrong slices corrupt reads.
    const body = 'body of notes/alpha.txt';
    const full = await fixture.request(`/v1/files/${ alpha() }/preview`);
    expect(full).toMatchObject({ status: 200, body });
    expect(full.headers['content-disposition']).toBeUndefined();
    const ranged = await fixture.request(`/v1/files/${ alpha() }/preview`, 'GET', { headers: { range: 'bytes=0-3' } });
    expect(ranged).toMatchObject({ status: 206, body: 'body' });
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${ body.length }`);
    const unsatisfiable = await fixture.request(`/v1/files/${ alpha() }/preview`, 'GET', { headers: { range: `bytes=${ body.length + 10 }-` } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers['content-range']).toBe(`bytes */${ body.length }`);
    const download = await fixture.request(`/v1/files/${ alpha() }/download`);
    expect(download).toMatchObject({ status: 200, body });
    expect(download.headers['content-disposition']).toBe(`attachment; filename="alpha.txt"; filename*=UTF-8''alpha.txt`);
    const actions = (await fixture.pool.query('SELECT action FROM audit_log WHERE file_id=$1', [alpha()])).rows.map(row => row.action);
    expect(actions).toEqual(expect.arrayContaining(['preview', 'download']));
    expect((await fixture.request(`/v1/files/${ randomUUID() }/download`)).status).toBe(404);
  });

  it('lists version history newest first with a version number', async() => {
    // risk: data accuracy — history drives restore; it must list this file's versions only, newest first.
    const history = await fixture.request(`/v1/files/${ alpha() }/history`);
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({ file_id: alpha(), version_number: expect.stringMatching(/^\d+\.\d+$/) });
    expect((await fixture.request(`/v1/files/${ randomUUID() }/history`)).status).toBe(404);
  });

  it('feeds recent files, collection stats and child-folder summaries', async() => {
    // risk: data accuracy — the home dashboard and folder sizes must count only live files of this collection.
    expect(await fixture.request('/v1/files/recent')).toMatchObject({ status: 400, body: { error: 'collectionId is required' } });
    expect(await fixture.request(`/v1/files/recent?collectionId=${ fixture.collectionId }&createdByType=robot`)).toMatchObject({ status: 400, body: { error: 'invalid createdByType' } });
    const recent = await fixture.request(`/v1/files/recent?collectionId=${ fixture.collectionId }`);
    expect(recent.status).toBe(200);
    expect(recent.body.map((row:any) => row.path).sort()).toEqual(['notes/alpha.txt', 'notes/beta.txt', 'notes/deep/gamma.txt']);
    expect(recent.body[0]).toMatchObject({ size: expect.any(Number), capabilities: expect.any(Object) });
    const stats = await fixture.request(`/v1/files/stats?collectionId=${ fixture.collectionId }`);
    expect(stats).toMatchObject({ status: 200, body: { fileCount: 3, totalBytes: ['notes/alpha.txt', 'notes/beta.txt', 'notes/deep/gamma.txt'].reduce((sum, path) => sum + `body of ${ path }`.length, 0) } });
    expect((await fixture.request(`/v1/files/stats?collectionId=${ fixture.unpublishedCollectionId }`)).status).toBe(404);
    const summary = await fixture.request(`/v1/folders/summary?collectionId=${ fixture.collectionId }&path=notes`);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual([expect.objectContaining({ path: 'notes/deep', name: 'deep' })]);
    expect(await fixture.request('/v1/folders/summary')).toMatchObject({ status: 400, body: { error: 'collectionId is required' } });
  });

  it('FileDetailRepository reads a version, edges and activity for one file', async() => {
    // risk: data accuracy — the repository must keep the original edge direction and activity ordering.
    const repository = new FileDetailRepository(fixture.pool);
    const versionId = (await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [alpha()])).rows[0].current_version_id;
    expect((await repository.version(versionId))?.id).toBe(versionId);
    expect(await repository.recording(alpha(), versionId)).toBeUndefined();
    const edges = await repository.edges(alpha());
    expect(edges).toHaveLength(3);
    expect(edges.map(edge => edge.linked_id)).toEqual(expect.arrayContaining([files['notes/beta.txt'], files['notes/deep/gamma.txt']]));
    const activity = await repository.activity(alpha());
    expect(activity.length).toBeLessThanOrEqual(100);
    expect(activity.map(row => row.at.getTime())).toEqual([...activity.map(row => row.at.getTime())].sort((a, b) => b - a));
    expect((await repository.history(alpha())).map(row => row.id)).toEqual([versionId]);
  });
});
