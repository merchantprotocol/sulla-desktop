// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { filesItem, type FilesApiFile, type FilesApiRecord } from '../../../../services/sulla-files/web-src/filesApiModels';

import type { FilesIndexCoverage, FilesItem, FilesOperationCapabilities, FilesTrashFile, FilesTrashFolder, FilesTrashItem } from './types';

/** Operation capabilities exactly as the main process reports them. */
export interface DesktopOperationCapabilities {
  enabled:boolean;
  reason?:string;
  folderReceipts?:boolean;
  nativeFolderReceipts?:boolean;
  folderCollisionPolicies?:('replace' | 'keep-both' | 'skip')[];
  crossCollectionOperations?:'all-authorized' | 'stored-authorized' | 'unavailable';
}

/** Maps Files IPC payloads into the renderer's Files types; pure, no I/O. */
export class DesktopFilesRecordMapper {
  /** Normalizes untrusted capability flags; anything unrecognized means unavailable. */
  operationCapabilities(value:DesktopOperationCapabilities):FilesOperationCapabilities {
    return {
      enabled:                   value.enabled === true,
      ...(typeof value.reason === 'string' ? { reason:value.reason } : {}),
      folderReceipts:            value.folderReceipts === true,
      nativeFolderReceipts:      value.nativeFolderReceipts === true,
      folderCollisionPolicies:   Array.isArray(value.folderCollisionPolicies) ? value.folderCollisionPolicies.filter((item):item is 'replace' | 'keep-both' | 'skip' => item === 'replace' || item === 'keep-both' || item === 'skip') : [],
      crossCollectionOperations: value.crossCollectionOperations === 'all-authorized' || value.crossCollectionOperations === 'stored-authorized' ? value.crossCollectionOperations : 'unavailable',
    };
  }

  /** A trash row as a file (version tombstone) or a folder (receipt tombstone). */
  trashItem(value:FilesApiRecord):FilesTrashItem {
    if (value.kind === 'folder') {
      return {
        kind:             'folder',
        id:               String(value.id),
        path:             String(value.path),
        revision:         String(value.revision),
        deletedAt:        String(value.deleted_at),
        currentTombstone: value.currentTombstone,
        capabilities:     value.capabilities,
      } as FilesTrashFolder;
    }
    const item = filesItem(value as FilesApiFile);

    return {
      ...item,
      kind:               'file',
      revision:           String(value.revision),
      operationRevision:  String(value.revision),
      currentVersionId:   String(value.currentTombstone?.id),
      currentTombstone:   value.currentTombstone,
    } as FilesTrashFile;
  }

  /** Index coverage counted from loaded rows, used when server stats are unavailable. */
  indexCoverage(files:FilesItem[]):FilesIndexCoverage {
    const coverage = { total: files.length, pending: 0, indexing: 0, indexed: 0, partial: 0, unsupported: 0, failed: 0, complete: true };
    for (const file of files) {
      coverage[file.indexStatus]++;
      if (file.indexStatus === 'indexed' && file.indexReasonCode?.endsWith('_partial')) coverage.partial++;
    }
    coverage.complete = coverage.pending === 0 && coverage.indexing === 0 && coverage.partial === 0 && coverage.unsupported === 0 && coverage.failed === 0;
    return coverage;
  }
}
