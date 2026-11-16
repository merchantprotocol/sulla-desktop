// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { nextTick, ref } from 'vue';

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';
import type { CloudFilesCollection, DisplayEntry } from './FilesBrowserTypes';

/** The folder details dialog (with its description guidance) and the Restore-from-Sulla-Cloud dialog. */
export class FilesBrowserDialogs {
  readonly folderDetails = ref<DisplayEntry | null>(null);
  readonly folderDialog = ref<HTMLDialogElement | null>(null);
  readonly folderDescription = ref('');
  readonly folderNamingHint = ref('');
  readonly cloudRestoreDialog = ref<HTMLDialogElement | null>(null);
  readonly cloudCollections = ref<CloudFilesCollection[]>([]);
  readonly cloudRestoreError = ref('');

  constructor(private readonly browser:FilesBrowserController) {}

  /** Details for a row: files open the detail pane, folders open the folder dialog. */
  readonly showDetails = async(entry:DisplayEntry):Promise<void> => { const state = this.browser.state; if (state.busy.value || state.loading.value || entry.rootCollectionId) return; this.browser.menus.closeActions(false); if (!entry.folder) { this.browser.navigation.selectEntry(entry); return } this.folderDetails.value = entry; this.folderDescription.value = entry.folderState?.description ?? ''; this.folderNamingHint.value = entry.folderState?.namingHint ?? ''; await nextTick(); this.folderDialog.value?.showModal() };

  readonly saveFolderGuidance = async():Promise<void> => { const source = this.browser.state.props.dataSource; const details = this.folderDetails.value; const folderState = details?.folderState; if (!details || !folderState || !source.updateFolderDescription || !this.folderDescription.value.trim()) return; const saved = await this.browser.refresher.runMutation(() => source.updateFolderDescription!(folderState.folderId, this.folderDescription.value.trim(), this.folderNamingHint.value.trim() || undefined)); if (saved) { this.folderDialog.value?.close(); this.folderDetails.value = null } };

  /** The folder dialog's native close event. */
  readonly closeFolderDetails = ():void => { this.folderDetails.value = null };

  readonly onFolderBackdrop = (event:MouseEvent):void => { const dialog = this.folderDialog.value; if (dialog && event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close() } };

  readonly openCloudRestore = async():Promise<void> => { const state = this.browser.state; this.cloudRestoreError.value = ''; state.operationError.value = ''; try { this.cloudCollections.value = await state.props.dataSource.listCloudCollections?.() ?? [] } catch (cause) { state.operationError.value = `Sulla Cloud backups could not be listed: ${ FilesBrowserState.messageOf(cause) }`; return } this.cloudRestoreDialog.value?.showModal() };

  readonly restoreCloudCollection = async(collection:CloudFilesCollection | 'all'):Promise<void> => {
    const state = this.browser.state; const refresh = this.browser.refresher.refresh;

    state.busy.value = true; this.cloudRestoreError.value = '';
    try {
      if (collection === 'all') {
        if (!state.props.dataSource.restoreAllCloudCollections) throw new Error('Cloud restore is unavailable.');
        const result = await state.props.dataSource.restoreAllCloudCollections();

        await refresh(true);
        if (result.failed.length) { this.cloudRestoreError.value = `${ result.failed.length } of ${ result.failed.length + result.restored.length } collections could not be verified and were not restored.`; this.cloudCollections.value = await state.props.dataSource.listCloudCollections?.() ?? []; return }
        this.cloudRestoreDialog.value?.close(); return;
      }
      if (!state.props.dataSource.restoreCloudCollection) throw new Error('Cloud restore is unavailable.');
      await state.props.dataSource.restoreCloudCollection(collection.collectionId, `Restored ${ new Date(collection.updatedAt).toLocaleDateString() }`); await refresh(true); this.cloudRestoreDialog.value?.close();
    } catch (cause) { this.cloudRestoreError.value = FilesBrowserState.messageOf(cause) } finally { state.busy.value = false }
  };
}
