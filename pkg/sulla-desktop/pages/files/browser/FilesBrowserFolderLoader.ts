// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';

/** Server reads that follow the view: the open folder, cross-folder sections, folder totals and expanded folders. */
export class FilesBrowserFolderLoader {
  private sectionGeneration = 0;
  private sectionFilesFor = '';
  private summaryGeneration = 0;
  private expandedLoading = false;

  constructor(private readonly browser:FilesBrowserController) {}

  /** Watch handler for currentPath: only the open folder's rows are loaded. */
  readonly loadFolder = async(path:string):Promise<void> => {
    const state = this.browser.state;

    if (state.section.value !== 'files' || !state.snapshot.value || !state.props.dataSource.loadFolder) return;
    try { const files = await state.props.dataSource.loadFolder(path); if (state.section.value === 'files' && state.currentPath.value === path && state.snapshot.value) state.snapshot.value = { ...state.snapshot.value, files: [...files] } } catch (error) { if (state.currentPath.value === path) state.operationError.value = FilesBrowserState.messageOf(error) }
  };

  readonly loadSectionFiles = async():Promise<void> => {
    const state = this.browser.state; const listing = this.browser.listing;
    const requested = state.section.value; const generation = ++this.sectionGeneration; const source = listing.sectionSource.value; const collectionId = state.snapshot.value?.collection.id ?? '';
    const key = `${ collectionId }:${ requested }`;

    if (key !== this.sectionFilesFor) { this.sectionFilesFor = key; listing.sectionFiles.value = null }
    if (!collectionId || !source.supports(requested)) return;
    try { const files = await source.load(requested, state.starred.value); if (generation === this.sectionGeneration && state.section.value === requested && state.snapshot.value?.collection.id === collectionId) listing.sectionFiles.value = files } catch (cause) { if (generation === this.sectionGeneration && state.section.value === requested) { listing.sectionFiles.value = []; state.operationError.value = FilesBrowserState.messageOf(cause) } }
  };

  readonly loadFolderSummaries = async():Promise<void> => {
    const state = this.browser.state; const listing = this.browser.listing;
    const source = state.props.dataSource; const collectionId = state.snapshot.value?.collection.id;

    if (!source.folderSummaries || !collectionId) return;
    const generation = ++this.summaryGeneration; const parents = new Set<string>(); const parentOf = (path:string) => path.split('/').slice(0, -1).join('/');

    if (state.section.value === 'files') { parents.add(state.currentPath.value); for (const path of state.expandedFolders.value) parents.add(path) }
    if (state.section.value === 'shared') for (const path of this.browser.location.sharedFolders.value) parents.add(parentOf(path));
    if (state.section.value === 'starred') for (const key of state.starred.value) if (key.startsWith('folder:')) parents.add(parentOf(key.slice('folder:'.length)));
    const results = await Promise.all([...parents].map(async parent => [parent, await source.folderSummaries!(parent).catch(() => null)] as const));

    if (generation !== this.summaryGeneration || state.snapshot.value?.collection.id !== collectionId) return;
    let next = listing.folderSummaries.value;

    for (const [parent, rows] of results) if (rows) next = next.set(parent, rows);
    listing.folderSummaries.value = next;
  };

  readonly loadExpandedFolders = async(reload:boolean):Promise<void> => {
    const state = this.browser.state; const listing = this.browser.listing;
    const source = state.props.dataSource; const collectionId = state.snapshot.value?.collection.id;

    if (!source.listFolderChildren || !collectionId || (reload && this.expandedLoading)) return;
    this.expandedLoading = true;
    try {
      for (const path of state.expandedFolders.value) {
        if (!reload && listing.expandedFolderFiles.value.has(path)) continue;
        const files = await source.listFolderChildren(path);

        if (state.snapshot.value?.collection.id !== collectionId || !state.expandedFolders.value.has(path)) continue;
        const next = new Map(listing.expandedFolderFiles.value); next.set(path, files); listing.expandedFolderFiles.value = next;
      }
    } catch (cause) { state.operationError.value = FilesBrowserState.messageOf(cause) } finally { this.expandedLoading = false }
  };
}
