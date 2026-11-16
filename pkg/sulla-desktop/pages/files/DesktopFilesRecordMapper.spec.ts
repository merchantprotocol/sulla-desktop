// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: permissions + data integrity. Capability flags from the main process decide whether the UI
// offers receipt-backed moves, cross-collection transfer and collision policies; anything not
// exactly recognized must read as unavailable. Trash rows carry the CAS revision and tombstone the
// restore/purge calls send back, so they must survive mapping unchanged.
import { describe, expect, it } from 'vitest';

import { DesktopFilesRecordMapper } from './DesktopFilesRecordMapper';

import type { FilesItem } from './types';

const mapper = new DesktopFilesRecordMapper();

describe('DesktopFilesRecordMapper', () => {
  it('passes through only exactly recognized operation capabilities', () => {
    expect(mapper.operationCapabilities({ enabled: true, reason: 'ok', folderReceipts: true, nativeFolderReceipts: false, folderCollisionPolicies: ['replace', 'overwrite' as never, 'skip'], crossCollectionOperations: 'stored-authorized' }))
      .toEqual({ enabled: true, reason: 'ok', folderReceipts: true, nativeFolderReceipts: false, folderCollisionPolicies: ['replace', 'skip'], crossCollectionOperations: 'stored-authorized' });
    expect(mapper.operationCapabilities({ enabled: 'yes' as never, folderReceipts: 1 as never, folderCollisionPolicies: 'replace' as never, crossCollectionOperations: 'everything' as never }))
      .toEqual({ enabled: false, folderReceipts: false, nativeFolderReceipts: false, folderCollisionPolicies: [], crossCollectionOperations: 'unavailable' });
  });

  it('maps a trashed folder with its receipt tombstone and revision as strings', () => {
    const tombstone = { kind: 'receipt', id: 'r1', receiptId: 'r1', undo: { state: 'available' } };

    expect(mapper.trashItem({ kind: 'folder', id: 7, path: 'Old', revision: 12, deleted_at: '2026-11-01T00:00:00Z', currentTombstone: tombstone, capabilities: { canEdit: true } }))
      .toEqual({ kind: 'folder', id: '7', path: 'Old', revision: '12', deletedAt: '2026-11-01T00:00:00Z', currentTombstone: tombstone, capabilities: { canEdit: true } });
  });

  it('maps a trashed file so its operation revision and current version come from the tombstone', () => {
    const tombstone = { kind: 'version', id: 'v9', undo: { state: 'invalidated' } };
    const item = mapper.trashItem({ id: 'f1', path: 'a.txt', current_version_id: 'v1', operation_revision: 3, revision: 44, deleted_at: '2026-11-02T00:00:00Z', currentTombstone: tombstone });

    expect(item).toMatchObject({ kind: 'file', id: 'f1', path: 'a.txt', revision: '44', operationRevision: '44', currentVersionId: 'v9', deletedAt: '2026-11-02T00:00:00Z', currentTombstone: tombstone });
  });

  it('counts index coverage and treats partial or unfinished indexing as incomplete', () => {
    const file = (indexStatus:FilesItem['indexStatus'], indexReasonCode?:string) => ({ indexStatus, indexReasonCode }) as FilesItem;

    expect(mapper.indexCoverage([file('indexed'), file('indexed')])).toEqual({ total: 2, pending: 0, indexing: 0, indexed: 2, partial: 0, unsupported: 0, failed: 0, complete: true });
    expect(mapper.indexCoverage([file('indexed', 'pdf_partial'), file('failed'), file('pending')]))
      .toEqual({ total: 3, pending: 1, indexing: 0, indexed: 1, partial: 1, unsupported: 0, failed: 1, complete: false });
    expect(mapper.indexCoverage([]).complete).toBe(true);
  });
});
