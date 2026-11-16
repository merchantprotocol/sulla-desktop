// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. Drag/drop, cut/paste and rename all become move/copy items from these rules: the wrong
// target path, a missing revision guard, or a file moved both on its own and inside its selected folder would
// move data to the wrong place or overwrite a newer version without the service's compare-and-swap check.
import { describe, expect, it } from 'vitest';

import { FilesDropTargets } from './FilesDropTargets';

import type { DisplayEntry } from './FilesBrowserTypes';

const entry = (path:string, extra:Partial<DisplayEntry> = {}):DisplayEntry => ({
  id: `id:${ path }`, key: `key:${ path }`, path, name: path.split('/').at(-1)!, folder: false, agent: false, childCount: 0, kindClass: 'doc', icon: '', subtitle: '',
  sortTimestamp: 0, mime: 'text/plain', size: 1, updatedAt: '', currentVersionId: `v:${ path }`, operationRevision: `r:${ path }`, versionCount: 1,
  createdByType: 'user', createdById: 'u', syncState: 'synced', indexStatus: 'indexed', indexReason: '', ...extra,
} as DisplayEntry);
const folder = (path:string, extra:Partial<DisplayEntry> = {}) => entry(path, { folder: true, mime: 'inode/directory', key: `folder:${ path }`, ...extra });
const signature = 'a'.repeat(64);

describe('FilesDropTargets', () => {
  it('joins a destination folder and a name, trimming slashes and keeping the root empty', () => {
    expect(FilesDropTargets.joinPath('', 'a.txt')).toBe('a.txt');
    expect(FilesDropTargets.joinPath('/Projects/', 'a.txt')).toBe('Projects/a.txt');
    expect(FilesDropTargets.joinPath('Projects/2026', 'a.txt')).toBe('Projects/2026/a.txt');
  });

  it('carries the exact version and revision of a file, and an isolated copy of a folder state', () => {
    const state = { collectionId: 'c1', folderId: 'f1', path: 'Docs', revision: '7' };
    const fileTarget = FilesDropTargets.toTarget(entry('Docs/a.txt'));
    const folderTarget = FilesDropTargets.toTarget(folder('Docs', { folderState: state }));

    expect(fileTarget).toEqual({ key: 'key:Docs/a.txt', fileId: 'id:Docs/a.txt', expectedVersionId: 'v:Docs/a.txt', expectedRevision: 'r:Docs/a.txt', path: 'Docs/a.txt', name: 'a.txt', folder: false });
    expect(folderTarget).toMatchObject({ folderPath: 'Docs', expectedFolder: state, folder: true });
    expect(folderTarget.expectedFolder).not.toBe(state);
    expect(folderTarget).not.toHaveProperty('fileId');
  });

  it('places a target inside the destination under its own name with its guards', () => {
    const fileItem = FilesDropTargets.operationTarget(FilesDropTargets.toTarget(entry('Inbox/a.txt')), 'Archive');
    const folderItem = FilesDropTargets.operationTarget({ ...FilesDropTargets.toTarget(folder('Inbox/Old')), sourceSubtreeSignature: signature }, '');

    expect(fileItem).toEqual({ fileId: 'id:Inbox/a.txt', expectedVersionId: 'v:Inbox/a.txt', expectedRevision: 'r:Inbox/a.txt', targetPath: 'Archive/a.txt' });
    expect(folderItem).toEqual({ folderPath: 'Inbox/Old', expectedFolder: undefined, sourceSubtreeSignature: signature, targetPath: 'Old' });
  });

  it('drags the whole selection only when the pressed row is selected, never a file twice', () => {
    const docs = folder('Docs'); const inside = entry('Docs/a.txt'); const outside = entry('b.txt'); const lone = entry('c.txt');
    const selected = [docs, inside, outside];
    const keys = new Set(selected.map(item => item.key));

    expect(FilesDropTargets.dragEntriesFor(outside, keys, selected).map(item => item.path)).toEqual(['Docs', 'b.txt']);
    expect(FilesDropTargets.dragEntriesFor(lone, keys, selected).map(item => item.path)).toEqual(['c.txt']);
    expect(FilesDropTargets.dragEntriesFor(outside, keys, []).map(item => item.path)).toEqual(['b.txt']);
    expect(FilesDropTargets.dragEntriesFor(entry('Docs2/x'), new Set(['key:Docs2/x', 'folder:Docs']), [docs, entry('Docs2/x')]).map(item => item.path)).toEqual(['Docs', 'Docs2/x']);
  });

  it('lets targets leave their collection only with a capability and a subtree snapshot for every folder', () => {
    const file = FilesDropTargets.toTarget(entry('a.txt'));
    const unsnapshotted = FilesDropTargets.toTarget(folder('Docs'));

    expect(FilesDropTargets.canLeaveCollection([file], 'all-authorized')).toBe(true);
    expect(FilesDropTargets.canLeaveCollection([file], 'unavailable')).toBe(false);
    expect(FilesDropTargets.canLeaveCollection([file, unsnapshotted], 'all-authorized')).toBe(false);
    expect(FilesDropTargets.canLeaveCollection([{ ...unsnapshotted, sourceSubtreeSignature: signature }], 'all-authorized')).toBe(true);
    expect(FilesDropTargets.hasSubtreeSignature('A'.repeat(64))).toBe(false);
  });
});
