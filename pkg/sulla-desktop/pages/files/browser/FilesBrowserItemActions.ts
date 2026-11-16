// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry } from './FilesBrowserTypes';
import type { FilesItem } from '../types';

/** One-click row and sidebar actions: star, favorite folders, pause sync, re-index, keep conflict copies. */
export class FilesBrowserItemActions {
  constructor(private readonly browser:FilesBrowserController) {}

  readonly toggleStar = async(id:string):Promise<void> => { const state = this.browser.state; if (!state.snapshot.value || this.browser.location.atRoots.value) return; const collectionId = state.snapshot.value.collection.id; const entry = this.browser.listing.visibleEntries.value.find(item => item.id === id); if (!entry) return; const next = !state.starred.value.has(id); await this.browser.refresher.runMutation(async() => { await state.props.dataSource.setStar(collectionId, entry.folder ? { folderPath: entry.path } : { fileId: entry.id }, next); const changed = new Set(state.starred.value); next ? changed.add(id) : changed.delete(id); state.starred.value = changed }, false) };

  readonly setFolderFavorite = async(path:string, favorite:boolean):Promise<void> => {
    const state = this.browser.state; const collectionId = state.snapshot.value?.collection.id;

    if (!collectionId || state.busy.value || state.loading.value || state.starred.value.has(`folder:${ path }`) === favorite) return;
    await this.browser.refresher.runMutation(() => state.props.dataSource.setStar(collectionId, { folderPath: path }, favorite));
  };

  readonly togglePause = async():Promise<void> => { const paused = this.browser.presenter.syncState.value !== 'paused'; await this.browser.refresher.runMutation(async() => { await this.browser.state.props.dataSource.setPaused(paused) }) };

  readonly reindex = async(entry:FilesItem):Promise<void> => { await this.browser.refresher.runMutation(() => this.browser.state.props.dataSource.reindex(entry.id)) };

  readonly recoverNativeSource = async(fileId:string):Promise<void> => { const source = this.browser.state.props.dataSource; if (source.recoverNativeSource) await this.browser.refresher.runMutation(async() => { await source.recoverNativeSource!(fileId) }) };

  readonly keepBothConflict = async(entry:DisplayEntry):Promise<void> => { const state = this.browser.state; if (!state.props.dataSource.keepConflictCopies) return; state.selectedKeys.value = new Set([entry.key]); this.browser.navigation.selectEntry(entry); await this.browser.refresher.runMutation(() => state.props.dataSource.keepConflictCopies!(entry)); const updated = state.snapshot.value?.files.find(file => file.id === entry.id); state.selected.value = updated ? this.browser.factory.toDisplay(updated) : null };

  readonly openFilePreferences = ():void => { this.browser.state.props.dataSource.openPreferences?.() };
}
