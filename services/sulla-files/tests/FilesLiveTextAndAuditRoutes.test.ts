// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the live text routes (LiveTextRoutes + LiveTextCoordinator) and the service audit-event
// spool (AuditEventRoutes) moved out of app.ts, on the real app and a real Postgres.
import * as Automerge from '@automerge/automerge';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { editTextDocument, type TextDocument } from '../src/automergeText.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files live text and audit-event routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  beforeAll(() => fixture.start(), 30_000);
  afterAll(() => fixture.stop());

  const sync = async(fileId:string, peerId:string, doc:Automerge.Doc<TextDocument>, state:Automerge.SyncState) => {
    for (let round = 0; round < 12; round++) {
      const [nextState, outgoing] = Automerge.generateSyncMessage(doc, state); state = nextState;
      if (!outgoing) break;
      const reply = await fixture.request(`/v1/files/${ fileId }/live/${ peerId }/sync`, 'POST', { body: { message: Buffer.from(outgoing).toString('base64') } });
      expect(reply.status).toBe(200);
      if (reply.body.message) [doc, state] = Automerge.receiveSyncMessage(doc, state, Buffer.from(reply.body.message, 'base64'));
    }
    return { doc, state };
  };

  it('opens a live session over UTF-8 text, saves its document and refuses binary content', async() => {
    // risk: data accuracy — the live session must start from the file's current version and persist its document.
    const fileId = await fixture.createFile('live/open.md');
    const file = (await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [fileId])).rows[0];
    const opened = await fixture.request(`/v1/files/${ fileId }/live`, 'POST', { body: {} });
    expect(opened).toMatchObject({ status: 200, body: { editable: true, versionId: file.current_version_id } });
    expect(opened.body.events).toBe(`/v1/files/${ fileId }/live/${ opened.body.peerId }/events`);
    expect((await fixture.pool.query('SELECT 1 FROM file_automerge_docs WHERE file_id=$1', [fileId])).rowCount).toBe(1);
    expect((await fixture.pool.query('SELECT heads FROM file_automerge_versions WHERE version_id=$1', [file.current_version_id])).rowCount).toBe(1);

    const binary = await fixture.request(`/v1/fuse/files?collectionId=${ fixture.collectionId }&path=live/blob.bin`, 'POST', { body: Buffer.from([0xff, 0xfe, 0x00, 0x81]), headers: { 'content-type': 'application/octet-stream' } });
    expect(await fixture.request(`/v1/files/${ binary.body.id }/live`, 'POST', { body: {} })).toMatchObject({ status: 415, body: { error: 'Live editing requires UTF-8 text up to 8 MiB' } });
    expect((await fixture.request(`/v1/files/${ fileId }/live/${ opened.body.peerId }`, 'DELETE')).status).toBe(204);
  });

  it('validates sync messages and only lets the owning principal use a peer', async() => {
    // risk: permissions — a peer id is bound to the principal that joined; others get 404.
    const fileId = await fixture.createFile('live/peer.md');
    const { body: { peerId } } = await fixture.request(`/v1/files/${ fileId }/live`, 'POST', { body: {} });
    expect(await fixture.request(`/v1/files/${ fileId }/live/${ peerId }/sync`, 'POST', { body: { message: 42 } })).toMatchObject({ status: 400, body: { error: 'Invalid sync message' } });
    const other = fixture.token({ job_id: 'job-other-peer' });
    const [, hello] = Automerge.generateSyncMessage(Automerge.init<TextDocument>(), Automerge.initSyncState());
    expect(await fixture.request(`/v1/files/${ fileId }/live/${ peerId }/sync`, 'POST', { body: { message: Buffer.from(hello!).toString('base64') }, token: other })).toMatchObject({ status: 404, body: { error: 'Live peer not found' } });
    expect((await fixture.request(`/v1/files/${ fileId }/live/not-a-peer`, 'DELETE')).status).toBe(404);
    expect((await fixture.request(`/v1/files/${ fileId }/live/${ peerId }`, 'DELETE')).status).toBe(204);
  });

  it('commits a live edit as a new version when the last peer leaves', async() => {
    // risk: data accuracy / irreversible write — a live edit must land exactly once as an audited version.
    const fileId = await fixture.createFile('live/edit.md');
    const before = (await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [fileId])).rows[0].current_version_id;
    const { body: { peerId } } = await fixture.request(`/v1/files/${ fileId }/live`, 'POST', { body: {} });
    let { doc, state } = await sync(fileId, peerId, Automerge.init<TextDocument>(), Automerge.initSyncState());
    expect(doc.text).toBe('body of live/edit.md');
    doc = editTextDocument(doc, 'edited live');
    ({ doc, state } = await sync(fileId, peerId, doc, state));
    expect((await fixture.request(`/v1/files/${ fileId }/live/${ peerId }`, 'DELETE')).status).toBe(204);

    const after = (await fixture.pool.query('SELECT current_version_id FROM files WHERE id=$1', [fileId])).rows[0].current_version_id;
    expect(after).not.toBe(before);
    expect((await fixture.pool.query('SELECT parent_version_id,message FROM file_versions WHERE id=$1', [after])).rows[0]).toEqual({ parent_version_id: before, message: 'Live document edit' });
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE file_id=$1 AND action='live-edit'", [fileId])).rows[0].n).toBe(1);
    const content = await fixture.request(`/v1/fuse/files/${ fileId }/content`);
    expect(content.body).toBe('edited live');
  });

  it('spools service audit events behind the local token', async() => {
    // risk: audit integrity — only the local service may append audit events, and invalid events are refused.
    const event = { subjectKind: 'file', subjectId: 'spec-subject', actor: 'agent-1', action: 'read', result: 'ok' };
    expect((await fixture.request('/v1/system/audit-events', 'POST', { body: event, headers: { 'x-sulla-files-token': 'wrong' } })).status).toBe(401);
    expect((await fixture.request('/v1/system/audit-events', 'POST', { body: { ...event, subjectKind: 'other' } })).status).toBe(400);
    expect(await fixture.request('/v1/system/audit-events', 'POST', { body: event })).toMatchObject({ status: 202, body: { ok: true } });
    const spooled = await fixture.pool.query("SELECT event FROM files_audit_spool WHERE event->>'subjectId'='spec-subject'");
    expect(spooled.rows.map(row => row.event.action)).toEqual(['read']);
  });
});
