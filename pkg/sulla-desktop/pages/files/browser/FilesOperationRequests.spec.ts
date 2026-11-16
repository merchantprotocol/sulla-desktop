// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. These are the exact durable operation items the Files service executes: a missing
// revision guard, a cross-collection item without its target collection or folder snapshot, or an oversized
// batch slipping through would move or overwrite data without the service's compare-and-swap protection.
import { describe, expect, it } from 'vitest';

import { FilesOperationRequests } from './FilesOperationRequests';

import type { OperationItem } from './FilesBrowserTypes';
import type { FilesOperationItem } from '../types';

const ids = () => { let next = 0; return () => `id-${ ++next }` };
const fileItem:OperationItem = { fileId: 'f1', expectedVersionId: 'v1', targetPath: 'Archive/a.txt' };
const folderItem:OperationItem = { folderPath: 'Docs', expectedFolder: { collectionId: 'c1', folderId: 'd1', path: 'Docs', revision: '3' }, sourceSubtreeSignature: 'b'.repeat(64), targetPath: 'Archive/Docs' };

describe('FilesOperationRequests', () => {
  it('fills a missing file revision from the loaded row within one collection', () => {
    const items = new FilesOperationRequests(ids()).build('move', [fileItem, folderItem], 'c1', 'c1', fileId => fileId === 'f1' ? 'r9' : undefined);

    expect(items).toEqual([
      { itemId: 'id-1', kind: 'file', action: 'move', fileId: 'f1', expectedVersionId: 'v1', expectedRevision: 'r9', targetPath: 'Archive/a.txt' },
      { itemId: 'id-2', kind: 'folder', action: 'move', folderPath: 'Docs', expectedFolder: folderItem.expectedFolder, targetPath: 'Archive/Docs' },
    ]);
  });

  it('names the target collection and carries the folder snapshot across collections, never guessing a revision', () => {
    const [file, folder] = new FilesOperationRequests(ids()).build('copy', [fileItem, folderItem], 'c1', 'c2', () => 'should-not-be-used');

    expect(file).toEqual({ itemId: 'id-1', kind: 'file', action: 'copy', fileId: 'f1', expectedVersionId: 'v1', expectedRevision: undefined, targetPath: 'Archive/a.txt', targetCollectionId: 'c2' });
    expect(folder).toMatchObject({ kind: 'folder', targetCollectionId: 'c2', sourceSubtreeSignature: 'b'.repeat(64) });
  });

  it('keeps a captured revision over the loaded one', () => {
    const [file] = new FilesOperationRequests(ids()).build('move', [{ ...fileItem, expectedRevision: 'r1' }], 'c1', 'c1', () => 'r9');

    expect(file.expectedRevision).toBe('r1');
  });

  it('blocks oversized batches first, then file items without both revision guards (folder creation exempt)', () => {
    const guarded:FilesOperationItem = { itemId: 'x', kind: 'file', action: 'trash', fileId: 'f', expectedVersionId: 'v', expectedRevision: 'r' };
    const unguarded:FilesOperationItem = { ...guarded, expectedRevision: undefined };

    expect(FilesOperationRequests.submitError([guarded])).toBe('');
    expect(FilesOperationRequests.submitError([{ itemId: 'n', action: 'create-folder', targetPath: 'New' }])).toBe('');
    expect(FilesOperationRequests.submitError([guarded, unguarded])).toBe('The service did not supply a revision for this item. Refresh Files before trying again.');
    expect(FilesOperationRequests.submitError(Array.from({ length: 251 }, () => unguarded))).toBe('Select at most 250 items for one operation.');
    expect(FilesOperationRequests.submitError(Array.from({ length: 250 }, () => guarded))).toBe('');
  });

  it('detects a folder moved into itself or its own subtree, but not into a sibling with a shared prefix', () => {
    expect(FilesOperationRequests.placesFolderInsideItself([{ folderPath: 'Docs', targetPath: 'Docs' }])).toBe(true);
    expect(FilesOperationRequests.placesFolderInsideItself([{ folderPath: 'Docs', targetPath: 'Docs/Old/Docs' }])).toBe(true);
    expect(FilesOperationRequests.placesFolderInsideItself([{ folderPath: 'Docs', targetPath: 'Docs2/Docs' }])).toBe(false);
    expect(FilesOperationRequests.placesFolderInsideItself([fileItem])).toBe(false);
  });
});
