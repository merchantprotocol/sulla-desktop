// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: irreversible side effects. Folder deletes, trash purges and uploads go to the main process
// through these commands; they must target the collection the user has open, send the exact CAS
// payloads (revision + tombstone) the service checks, and refuse uploads they cannot read.
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ paths: new Map<object, string>() }));
vi.mock('electron', () => ({ webUtils: { getPathForFile: (file:object) => electron.paths.get(file) ?? '' }, ipcRenderer: {} }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: {} }));

import { DesktopFilesDataSource } from './DesktopFilesDataSource';

import type { FilesTrashItem } from './types';

/** Records every IPC call; answers the constructor's native-runtime probe. */
class FakeIpc {
  readonly invoked:{ channel:string; input:unknown }[] = [];
  readonly listeners:string[] = [];
  invoke = (channel:string, input?:unknown):Promise<unknown> => {
    if (channel === 'files-ui:native-runtime') return Promise.resolve({ state: 'disabled', ready: false, generation: 0, sourceGrant: 'unsupported' });
    this.invoked.push({ channel, input });
    return Promise.resolve(channel === 'sulla-files:shares' ? [{ folder_path: 'Shared', principal_type: 'user', principal_id: 'u2', role: 'view' }] : undefined);
  };

  on = (channel:string) => { this.listeners.push(channel); return this };
  removeListener = () => this;
  send = () => undefined;
}

const make = () => {
  const ipc = new FakeIpc();
  const source = new DesktopFilesDataSource(ipc as never);

  source.selectCollection('c1');
  return { ipc, source };
};

describe('DesktopFilesIpcCommands (through DesktopFilesDataSource)', () => {
  it('sends folder and file commands for the open collection only', async() => {
    const { ipc, source } = make();

    await source.deleteFolder('Old/Stuff');
    await source.createFile('notes.md');
    await source.uploadPaths(['/tmp/a.txt'], 'Inbox');
    source.selectCollection('c2');
    await source.deleteFolder('Other');

    expect(ipc.invoked).toEqual([
      { channel: 'files-ui:delete-folder', input: { collectionId: 'c1', path: 'Old/Stuff' } },
      { channel: 'sulla-files:create-empty-file', input: { collectionId: 'c1', path: 'notes.md' } },
      { channel: 'files-ui:upload-paths', input: { paths: ['/tmp/a.txt'], destination: 'Inbox', collectionId: 'c1' } },
      { channel: 'files-ui:delete-folder', input: { collectionId: 'c2', path: 'Other' } },
    ]);
    expect(ipc.listeners).toContain('files-ui:native-runtime-changed');
  });

  it('purges trash with the exact revision and tombstone CAS payload for files and folders', async() => {
    const { ipc, source } = make();
    const file = { kind: 'file', id: 'f1', revision: '5', currentTombstone: { kind: 'version', id: 'v5', undo: { state: 'available' } } } as unknown as FilesTrashItem;
    const receiptFile = { ...file, currentTombstone: { kind: 'version', id: 'v6', receiptId: 'r6', undo: { state: 'available' } } } as unknown as FilesTrashItem;
    const folder = { kind: 'folder', id: 'd1', revision: '9', currentTombstone: { kind: 'receipt', id: 'r1', receiptId: 'r1', undo: { state: 'available' } } } as unknown as FilesTrashItem;

    await source.purgeTrashItem(file);
    await source.purgeTrashItem(receiptFile);
    await source.purgeTrashItem(folder);
    await source.restoreTrashItem(folder);

    expect(ipc.invoked.map(call => call.input)).toEqual([
      { id: 'f1', expectedRevision: '5', currentTombstone: { id: 'v5' } },
      { id: 'f1', expectedRevision: '5', currentTombstone: { id: 'v6' }, invalidateUndo: true },
      { id: 'd1', kind: 'folder', expectedRevision: '9', currentTombstone: { kind: 'receipt', id: 'r1', receiptId: 'r1' }, invalidateUndo: true },
      { id: 'd1', kind: 'folder', expectedRevision: '9', currentTombstone: { id: 'r1', receiptId: 'r1' } },
    ]);
  });

  it('refuses dropped files it cannot resolve to a path and uploads nothing', () => {
    const { ipc, source } = make();
    const readable = {} as File; const unreadable = {} as File;

    electron.paths.set(readable, '/Users/me/a.txt');
    expect(() => source.uploadDroppedFiles([readable, unreadable])).toThrow('Sulla could not read one or more dropped files. Use Choose files instead.');
    expect(ipc.invoked).toEqual([]);
  });

  it('refuses to keep conflict copies without the conflict source identity', () => {
    const { ipc, source } = make();

    expect(() => source.keepConflictCopies({ id: 'f1', currentVersionId: 'v1' } as never)).toThrow('This conflict cannot be acknowledged safely. Refresh Files and try again.');
    expect(ipc.invoked).toEqual([]);
  });

  it('maps folder shares for the requested collection', async() => {
    const { source } = make();

    expect(await source.listFolderShares('c9')).toEqual([expect.objectContaining({ collectionId: 'c9', folderPath: 'Shared', principalId: 'u2', role: 'view' })]);
  });
});
