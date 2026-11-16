// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { supportsDocumentEditor } from '../editor/editorTypes';
import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';
import type { FilesTargetAction } from './FilesBrowserTypes';

/** Runs the row action menu's choice against the row it was opened on. */
export class FilesBrowserTargetActions {
  constructor(private readonly browser:FilesBrowserController) {}

  readonly runTargetAction = async(action:FilesTargetAction):Promise<void> => {
    const browser = this.browser; const state = browser.state; const source = state.props.dataSource;
    const target = browser.menus.actionTarget.value; if (!target || state.busy.value || state.loading.value) return; browser.menus.closeActions();

    if (action === 'open') { browser.navigation.activate(target); return }
    if (action === 'new-folder' || action === 'new-file') { if (target.folder) await (action === 'new-folder' ? browser.creation.newFolder(target.path) : browser.creation.newFile(target.path)); return }
    if (action === 'open-sulla') { if (!target.folder && supportsDocumentEditor(target.path)) state.emit('open-editor', target, state.snapshot.value?.collection.id); else browser.navigation.selectEntry(target); return }
    if (action === 'native-open') { await browser.refresher.runMutation(() => (source.openFileWithDefaultApp ?? source.openFile).call(source, target.id, target.currentVersionId), false); return }
    if (action === 'reveal') {
      if (!source.capabilities.nativeReveal || !source.revealFile) return;
      try {
        const result = await source.revealFile(target.id, target.currentVersionId);

        if (result.status === 'unavailable') state.operationError.value = result.reason;
      } catch (cause) { state.operationError.value = FilesBrowserState.messageOf(cause) }
      return;
    }
    if (action === 'reference') { try { const params = new URLSearchParams({ version: target.currentVersionId, path: target.path, name: target.name }); await navigator.clipboard.writeText(`sulla-file://${ target.id }?${ params }`) } catch (cause) { state.operationError.value = FilesBrowserState.messageOf(cause) } return }
    if (action === 'details') { await browser.dialogs.showDetails(target); return }
    if (action === 'share') {
      if (target.folder && state.snapshot.value) state.shareTarget.value = { id: target.id, name: target.name, folder: true, path: target.path, collectionId: state.snapshot.value.collection.id, orgId: state.snapshot.value.collection.orgId, ownerUserId: state.snapshot.value.collection.ownerUserId };
      else browser.sharing.shareEntry(target);
      return;
    }
    if (['rename', 'online-only', 'keep-local', 'restore', 'purge'].includes(action)) state.selectedKeys.value = new Set([target.key]);
    if (action === 'rename') browser.rename.renameSelected(); else if (action === 'move') await browser.fileOperations.moveSelected(); else if (action === 'copy' || action === 'cut') void browser.fileOperations.copyToClipboard(action); else if (action === 'download') await browser.fileOperations.downloadSelected();
    else if (action === 'restore') await browser.trash.restoreSelected(); else if (action === 'purge') await browser.trash.purgeSelected();
    else if (action === 'online-only' || action === 'keep-local') { const operation = action === 'online-only' ? source.makeOnlineOnly : source.keepOnMac; if (!operation) return; await browser.refresher.runMutation(() => operation.call(source, target.id)) } else await browser.fileOperations.trashSelected();
  };
}
