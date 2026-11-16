// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isFilesFolderReplacementDestination, isFilesFolderState, isFilesOperationState, type FilesCollisionDestination, type FilesOperationItemReceipt } from '../types';

/**
 * Whether a destination-conflict item may be retried with "Replace": only against an authorized, current
 * destination snapshot of the same kind in the open collection. Pure rules, no Vue.
 */
export class FilesCollisionDestinations {
  /** The kind of the source an operation item moved, from its before/after state. */
  static itemKind(item:FilesOperationItemReceipt):'file' | 'folder' | undefined {
    const state = item.before ?? item.after;

    if (isFilesOperationState(state)) return 'file';
    if (isFilesFolderState(state)) return 'folder';
  }

  /**
   * The destination Replace would overwrite, or undefined when Replace is not allowed: folder creation never replaces,
   * deleted or foreign-collection destinations are refused, kinds must match, and folders need the replace policy.
   */
  static replaceDestination(item:FilesOperationItemReceipt, openCollectionId:string | undefined, folderReplaceAllowed:boolean):FilesCollisionDestination | undefined {
    if (item.action === 'create-folder') return;
    const destination = item.error?.destination;
    const sourceKind = FilesCollisionDestinations.itemKind(item);

    if (isFilesOperationState(destination)) {
      if (sourceKind && sourceKind !== 'file') return;
      return destination.deleted || (destination.collectionId !== undefined && destination.collectionId !== openCollectionId) ? undefined : destination;
    }
    if (isFilesFolderReplacementDestination(destination)) {
      if (sourceKind && sourceKind !== 'folder') return;
      if (destination.collectionId !== undefined && destination.collectionId !== openCollectionId) return;
      return folderReplaceAllowed ? destination : undefined;
    }
  }
}
