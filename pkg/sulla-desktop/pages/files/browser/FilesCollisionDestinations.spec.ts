// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: irreversible side effects. "Replace" overwrites the destination. It may only be offered against a
// current, same-kind destination snapshot in the open collection; a deleted, foreign-collection or
// mismatched-kind destination, or folder creation, must never be replaced.
import { describe, expect, it } from 'vitest';

import { FilesCollisionDestinations } from './FilesCollisionDestinations';

import type { FilesOperationItemReceipt } from '../types';

const fileState = { fileId: 'f1', path: 'a.txt', versionId: 'v1', revision: '1', deleted: false };
const folderState = { folderId: 'd1', path: 'Docs', revision: '2' };
const conflict = (destination:unknown, extra:Partial<FilesOperationItemReceipt> = {}):FilesOperationItemReceipt => ({
  itemId: 'i', action: 'move', state: 'failed', receiptId: null, before: fileState, after: null, undoSupported: false, retryable: true,
  error: { status: 409, code: 'destination-conflict', message: 'exists', destination: destination as never }, ...extra,
});

describe('FilesCollisionDestinations', () => {
  it('replaces a current file destination in the open collection', () => {
    const destination = { ...fileState, fileId: 'f2', collectionId: 'c1' };

    expect(FilesCollisionDestinations.replaceDestination(conflict(destination), 'c1', false)).toBe(destination);
    expect(FilesCollisionDestinations.replaceDestination(conflict({ ...fileState, fileId: 'f2' }), 'c1', false)).toBeDefined();
  });

  it('refuses deleted, foreign-collection and kind-mismatched file destinations', () => {
    expect(FilesCollisionDestinations.replaceDestination(conflict({ ...fileState, deleted: true }), 'c1', true)).toBeUndefined();
    expect(FilesCollisionDestinations.replaceDestination(conflict({ ...fileState, collectionId: 'c2' }), 'c1', true)).toBeUndefined();
    expect(FilesCollisionDestinations.replaceDestination(conflict(fileState, { before: folderState }), 'c1', true)).toBeUndefined();
  });

  it('replaces a folder destination only with its subtree snapshot and the folder replace policy', () => {
    const destination = { ...folderState, subtreeSignature: 'c'.repeat(64) };
    const folderMove = { before: folderState };

    expect(FilesCollisionDestinations.replaceDestination(conflict(destination, folderMove), 'c1', true)).toBe(destination);
    expect(FilesCollisionDestinations.replaceDestination(conflict(destination, folderMove), 'c1', false)).toBeUndefined();
    expect(FilesCollisionDestinations.replaceDestination(conflict(folderState, folderMove), 'c1', true)).toBeUndefined();
    expect(FilesCollisionDestinations.replaceDestination(conflict({ ...destination, collectionId: 'c9' }, folderMove), 'c1', true)).toBeUndefined();
    expect(FilesCollisionDestinations.replaceDestination(conflict(destination), 'c1', true)).toBeUndefined();
  });

  it('never replaces for folder creation', () => {
    expect(FilesCollisionDestinations.replaceDestination(conflict({ ...fileState, fileId: 'f2' }, { action: 'create-folder', before: null }), 'c1', true)).toBeUndefined();
  });

  it('reads the moved kind from before, falling back to after', () => {
    expect(FilesCollisionDestinations.itemKind(conflict(null))).toBe('file');
    expect(FilesCollisionDestinations.itemKind(conflict(null, { before: null, after: folderState }))).toBe('folder');
    expect(FilesCollisionDestinations.itemKind(conflict(null, { before: null, after: null }))).toBeUndefined();
  });
});
