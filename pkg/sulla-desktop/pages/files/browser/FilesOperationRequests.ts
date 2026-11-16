// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { OperationItem } from './FilesBrowserTypes';
import type { FilesOperationItem } from '../types';

/** Builds durable operation request items from move/copy items. Pure rules; ids come from the injected factory. */
export class FilesOperationRequests {
  /** The most items one durable operation may carry. */
  static readonly MAX_ITEMS = 250;

  constructor(private readonly newId:() => string = () => crypto.randomUUID()) {}

  /**
   * One request item per move/copy item. Within one collection a file without a captured revision falls back to the
   * loaded row's revision (`revisionOf`); across collections the target collection is named and folders carry their
   * captured subtree signature.
   */
  build(action:'move' | 'copy', items:OperationItem[], collectionId:string, destinationCollectionId:string, revisionOf:(fileId:string | undefined) => string | undefined):FilesOperationItem[] {
    const crossCollection = collectionId !== destinationCollectionId;

    return items.map(item => item.folderPath ? {
      itemId: this.newId(), kind: 'folder', action, folderPath: item.folderPath, expectedFolder: item.expectedFolder, targetPath: item.targetPath,
      ...(crossCollection ? { targetCollectionId: destinationCollectionId, sourceSubtreeSignature: item.sourceSubtreeSignature } : {}),
    } : {
      itemId: this.newId(), kind: 'file', action, fileId: item.fileId, expectedVersionId: item.expectedVersionId,
      expectedRevision: item.expectedRevision ?? (crossCollection ? undefined : revisionOf(item.fileId)), targetPath: item.targetPath,
      ...(crossCollection ? { targetCollectionId: destinationCollectionId } : {}),
    });
  }

  /** The inline error that blocks submitting these items, or '' when they may be submitted. */
  static submitError(items:FilesOperationItem[]):string {
    if (items.length > FilesOperationRequests.MAX_ITEMS) return 'Select at most 250 items for one operation.';
    if (items.some(item => item.kind !== 'folder' && item.action !== 'create-folder' && (!item.expectedVersionId || !item.expectedRevision))) return 'The service did not supply a revision for this item. Refresh Files before trying again.';
    return '';
  }

  /** True when a same-collection move/copy would put a folder inside itself. */
  static placesFolderInsideItself(items:OperationItem[]):boolean {
    return items.some(item => item.folderPath && (item.targetPath === item.folderPath || item.targetPath.startsWith(item.folderPath + '/')));
  }
}
