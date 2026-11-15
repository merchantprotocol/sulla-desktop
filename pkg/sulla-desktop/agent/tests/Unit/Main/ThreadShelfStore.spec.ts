// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

import { buildNote, parseNote } from '@pkg/pages/chat/messages/shelfNote';
import { ThreadShelfStore } from '@pkg/main/threadShelf';

const meta = { name: 'RC billing', status: 'shelved' as const, shelvedAt: '2026-11-14T22:00:00.000Z', chatThreadId: 't_abc' };

/** In-memory stand-in for the Files endpoints the store uses. */
function fakeFiles() {
  const files = new Map<string, { path: string; text: string; version: number; trashed: boolean }>();
  let ids = 0;
  const request = vi.fn(async(path: string, init: RequestInit = {}) => {
    if (path === '/v1/collections') return [{ id: 'logs', system_area: 'logs' }, { id: 'home', explorer_path: '' }];
    if (path.startsWith('/v1/files?')) {
      const folder = new URL(`http://x${ path }`).searchParams.get('path')!;
      return [...files.entries()].filter(([, f]) => !f.trashed && f.path.startsWith(`${ folder }/`)).map(([id, f]) => ({ id, path: f.path }));
    }
    if (path === '/v1/agent-files' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.collectionId !== 'home') throw new Error('wrong collection');
      if (body.fileId) {
        const f = files.get(body.fileId)!;
        if (String(f.version) !== body.expectedVersionId) throw new Error('version conflict');
        Object.assign(f, { text: body.content, version: f.version + 1 });
        return { fileId: body.fileId };
      }
      const id = `f${ ++ids }`;
      files.set(id, { path: body.path, text: body.content, version: 1, trashed: false });
      return { fileId: id };
    }
    const read = /^\/v1\/agent-files\/(\w+)$/.exec(path);
    if (read) { const f = files.get(read[1])!; return { file: { path: f.path }, version: { id: String(f.version) }, content_base64: Buffer.from(f.text).toString('base64') } }
    const del = /^\/v1\/files\/(\w+)$/.exec(path);
    if (del && init.method === 'DELETE') { files.get(del[1])!.trashed = true; return undefined }
    throw new Error(`unexpected ${ init.method ?? 'GET' } ${ path }`);
  });
  return { files, request };
}

describe('shelf notes in Sulla Files', () => {
  it('saves a note under Projects/Shelf in the home collection and lists it back', async() => {
    const { request } = fakeFiles();
    const store = new ThreadShelfStore(request);
    const saved = await store.save(meta, '## Goal\nFinish billing.');
    expect(saved).toMatchObject({ slug: 'rc-billing', path: 'Projects/Shelf/rc-billing.md' });
    const [entry] = await store.list();
    expect(entry).toMatchObject({ slug: 'rc-billing', goal: 'Finish billing.', meta: { name: 'RC billing', status: 'shelved' } });
  });

  // risk: shelving twice with one name destroyed the earlier handoff note
  it('never overwrites an existing note', async() => {
    const { request } = fakeFiles();
    const store = new ThreadShelfStore(request);
    await store.save(meta, 'one');
    expect((await store.save(meta, 'two')).slug).toBe('rc-billing-2');
    expect(await store.list()).toHaveLength(2);
  });

  it('ignores unrelated files in the folder', async() => {
    const { files, request } = fakeFiles();
    files.set('x', { path: 'Projects/Shelf/readme.md', text: '# not a note', version: 1, trashed: false });
    files.set('y', { path: 'Projects/Shelf/old/a.md', text: buildNote(meta, 'x'), version: 1, trashed: false });
    expect(await new ThreadShelfStore(request).list()).toEqual([]);
  });

  it('marks a note resumed in place, guarded by its current version', async() => {
    const { files, request } = fakeFiles();
    const store = new ThreadShelfStore(request);
    const { fileId } = await store.save(meta, '## Goal\nShip.');
    await store.markResumed(fileId, 't_new');
    expect(parseNote(files.get(fileId)!.text)!.meta).toMatchObject({ status: 'resumed', resumedThreadId: 't_new' });
  });

  it('deletes by moving the note to the trash', async() => {
    const { files, request } = fakeFiles();
    const store = new ThreadShelfStore(request);
    const { fileId } = await store.save(meta, 'x');
    await store.trash(fileId);
    expect(files.get(fileId)!.trashed).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});
