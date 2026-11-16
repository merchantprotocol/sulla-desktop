// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesExplorerInteractions, type ExplorerColumns, type ExplorerLocation, type ExplorerTarget } from './FilesExplorerInteractions';

import type { FilesCrossCollectionCapability } from '../types';

export { FilesExplorerInteractions } from './FilesExplorerInteractions';
export type { ExplorerClipboard, ExplorerColumns, ExplorerFolderPreferences, ExplorerLocation, ExplorerPreferenceStorage, ExplorerTarget } from './FilesExplorerInteractions';

/** Thin Vue binding: one FilesExplorerInteractions per Files tab. */
export function useFilesExplorerInteractions(tabId:string) {
  const explorer = new FilesExplorerInteractions(tabId);

  return {
    backStack:             explorer.backStack,
    forwardStack:          explorer.forwardStack,
    clipboard:             explorer.clipboard,
    canGoBack:             explorer.canGoBack,
    canGoForward:          explorer.canGoForward,
    visit:                 (current:ExplorerLocation, next:ExplorerLocation) => explorer.visit(current, next),
    back:                  (current:ExplorerLocation) => explorer.back(current),
    forward:               (current:ExplorerLocation) => explorer.forward(current),
    clearForCollection:    (collectionId:string) => explorer.clearForCollection(collectionId),
    setClipboard:          (collectionId:string, sourceCapability:FilesCrossCollectionCapability, mode:'copy' | 'cut', targets:ExplorerTarget[]) => explorer.setClipboard(collectionId, sourceCapability, mode, targets),
    loadFolderPreferences: (collectionId:string, path:string) => explorer.loadFolderPreferences(collectionId, path),
    saveFolderPreferences: (collectionId:string, path:string, value:{ sort:string; direction:'asc' | 'desc'; columns:ExplorerColumns; view:'list' | 'grid' }) => explorer.saveFolderPreferences(collectionId, path, value),
  };
}
