// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed } from 'vue';

import { FilesBrowserState } from './FilesBrowserState';
import { FilesDropTargets } from './FilesDropTargets';
import { FilesOperationRequests } from './FilesOperationRequests';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry, OperationItem } from './FilesBrowserTypes';
import type { ExplorerTarget } from '../composables/useFilesExplorerInteractions';
import type { FilesCrossCollectionCapability, FilesItem, FilesOperationItem, FilesOperationReceipt } from '../types';

/** Move, copy, cut/paste, download and Trash of the selection, through durable receipts when the source has them. */
export class FilesBrowserFileOperations {
  private readonly requests = new FilesOperationRequests();

  readonly canPaste = computed(() => { const state = this.browser.state; const clipboard = this.browser.explorer.clipboard; return Boolean(state.snapshot.value && state.section.value === 'files' && clipboard.value?.targets.length &&
    (clipboard.value.collectionId === state.snapshot.value.collection.id ||
     (clipboard.value.sourceCapability !== 'unavailable' && state.props.dataSource.capabilities.crossCollectionOperations !== 'unavailable' &&
      clipboard.value.targets.every(target => !target.folder || FilesDropTargets.hasSubtreeSignature(target.sourceSubtreeSignature))))) });

  readonly crossCollectionClipboardMessage = computed(() => {
    const clipboard = this.browser.explorer.clipboard; const snapshot = this.browser.state.snapshot;

    if (!clipboard.value || !snapshot.value || clipboard.value.collectionId === snapshot.value.collection.id) return '';
    if (this.canPaste.value) return `Ready to ${ clipboard.value.mode === 'cut' ? 'move' : 'copy' } ${ clipboard.value.targets.length } item${ clipboard.value.targets.length === 1 ? '' : 's' } from another collection.`;
    return 'Clipboard kept from another collection, but the source or destination does not authorize this transfer.';
  });

  constructor(private readonly browser:FilesBrowserController) {}

  private hasPendingOperation():boolean { const operations = this.browser.operations; return Boolean(operations.pendingRequest.value || operations.receipts.value.some(receipt => receipt.state === 'pending')) }

  private requestItems(action:'move' | 'copy', items:OperationItem[], collectionId:string, destinationCollectionId:string):FilesOperationItem[] {
    return this.requests.build(action, items, collectionId, destinationCollectionId, fileId => this.browser.state.snapshot.value?.files.find(file => file.id === fileId)?.operationRevision);
  }

  /** Move or copy items into the open folder, from this or (with a captured capability) another collection. */
  readonly perform = async(action:'move' | 'copy', items:OperationItem[], sourceCollectionId?:string, capturedSourceCapability?:FilesCrossCollectionCapability):Promise<boolean | undefined> => {
    const state = this.browser.state; const source = state.props.dataSource; const operations = this.browser.operations;

    if (this.browser.location.readOnlyArea.value) return;
    if (state.busy.value || !state.snapshot.value || !items.length) return false;
    const destinationCollectionId = state.snapshot.value.collection.id;
    const destinationPath = state.currentPath.value;
    const destinationSnapshot = state.snapshot.value;
    const collectionId = sourceCollectionId ?? destinationCollectionId;
    const crossCollection = collectionId !== destinationCollectionId;

    if (!crossCollection && FilesOperationRequests.placesFolderInsideItself(items)) { state.operationError.value = 'A folder cannot be placed inside itself.'; return false }
    if (crossCollection) {
      if (!capturedSourceCapability || capturedSourceCapability === 'unavailable' || source.capabilities.crossCollectionOperations === 'unavailable' || !source.operationCapabilities) { state.operationError.value = 'The source or destination does not authorize a receipt-backed transfer.'; return false }
      if (items.some(item => item.folderPath && (!FilesDropTargets.hasSubtreeSignature(item.sourceSubtreeSignature) || (item.expectedFolder?.collectionId !== undefined && item.expectedFolder.collectionId !== collectionId)))) { state.operationError.value = 'Cross-collection folders require the source snapshot captured when the drag or clipboard selection began.'; return false }
      state.busy.value = true; state.operationError.value = ''; let submitted = false;

      try {
        const [sourceCapabilities, destinationCapabilities] = await Promise.all([source.operationCapabilities(collectionId), source.operationCapabilities(destinationCollectionId)]);

        if (!state.mounted || state.snapshot.value !== destinationSnapshot || state.snapshot.value.collection.id !== destinationCollectionId || state.currentPath.value !== destinationPath) { state.operationError.value = 'The destination changed before the transfer was submitted, so nothing was moved.'; return false }
        if (!sourceCapabilities.enabled || !destinationCapabilities.enabled || sourceCapabilities.crossCollectionOperations === 'unavailable' || destinationCapabilities.crossCollectionOperations === 'unavailable') { state.operationError.value = 'The source or destination does not authorize a receipt-backed transfer.'; return false }
        if (items.some(item => item.folderPath) && (!sourceCapabilities.folderReceipts || !destinationCapabilities.folderReceipts)) { state.operationError.value = 'The source or destination does not authorize receipt-backed folder transfers.'; return false }
        if (!operations.supported()) { state.operationError.value = 'Cross-collection transfer requires durable operation receipts.'; return false }
        const requests = this.requestItems(action, items, collectionId, destinationCollectionId);

        if (this.hasPendingOperation()) { state.operationError.value = 'Resolve the pending operation before starting another.'; return false }
        if (requests.length > FilesOperationRequests.MAX_ITEMS) { state.operationError.value = 'Select at most 250 items for one operation.'; return false }
        if (requests.some(item => item.kind !== 'folder' && (!item.expectedVersionId || !item.expectedRevision))) { state.operationError.value = 'The service did not supply a revision for this item. Refresh Files before trying again.'; return false }
        state.operationNotice.value = ''; submitted = true;
        const receipt = await operations.submit({ idempotencyKey: crypto.randomUUID(), collectionId, items: requests });

        return Boolean(receipt && receipt.items.every(item => item.state === 'completed'));
      } catch (cause) { state.operationError.value = FilesBrowserState.messageOf(cause); return false } finally { if (submitted && state.mounted) await this.browser.refresher.refresh(true, true); state.busy.value = false }
    }
    const receiptSupported = operations.supported() && items.every(item => item.fileId || (item.folderPath && source.capabilities.folderReceipts));

    if (receiptSupported) return this.submitReceiptItems(this.requestItems(action, items, collectionId, destinationCollectionId), collectionId);
    state.operationNotice.value = 'This operation reports completion only. Undo, collision choices, cancellation and retry are unavailable.';
    return this.browser.refresher.runMutation(async() => { await source.operate(action, collectionId, items); state.selectedKeys.value = new Set(); this.browser.menus.closeActions(false) });
  };

  readonly submitReceiptItems = async(items:FilesOperationItem[], collectionId = this.browser.state.snapshot.value?.collection.id):Promise<boolean> => {
    const state = this.browser.state;

    if (!state.snapshot.value || this.hasPendingOperation()) { state.operationError.value = 'Resolve the pending operation before starting another.'; return false }
    if (!collectionId) return false;
    const blocked = FilesOperationRequests.submitError(items);

    if (blocked) { state.operationError.value = blocked; return false }
    let receipt:FilesOperationReceipt | null = null;

    state.operationNotice.value = '';
    await this.browser.refresher.runMutation(async() => { receipt = await this.browser.operations.submit({ idempotencyKey: crypto.randomUUID(), collectionId, items }) });
    return Boolean(receipt && (receipt as FilesOperationReceipt).items.every(item => item.state === 'completed'));
  };

  /** The exact source a gesture carries; folders get their subtree snapshot when the source can provide one. */
  readonly captureTarget = async(entry:DisplayEntry, collectionId:string):Promise<ExplorerTarget> => {
    const source = this.browser.state.props.dataSource; const target = FilesDropTargets.toTarget(entry);

    if (!entry.folder) return target;
    if (!source.folderOperationState) return target;
    try {
      const state = await source.folderOperationState(collectionId, entry.path);

      if (state.collectionId !== collectionId || state.path !== entry.path || !FilesDropTargets.hasSubtreeSignature(state.subtreeSignature) || Boolean(state.folderId) !== Boolean(state.revision)) return target;
      return { ...target, expectedFolder: state.folderId && state.revision ? { collectionId, folderId: state.folderId, path: state.path, revision: state.revision } : undefined, sourceSubtreeSignature: state.subtreeSignature };
    } catch { return target }
  };

  readonly moveSelected = async():Promise<void> => { const state = this.browser.state; const entries = this.browser.selection.selectedEntries.value; if (state.busy.value || state.loading.value || !entries.length) return; const destination = await this.browser.creation.askName('Move to folder', 'Folder path (leave empty for My Files)', 'Move', state.currentPath.value, true); if (destination === null) return; await this.perform('move', FilesDropTargets.operationItems(entries, destination)) };

  readonly copyToClipboard = async(mode:'copy' | 'cut'):Promise<void> => {
    const state = this.browser.state; const selected = this.browser.selection.selectedEntries.value;

    if (this.browser.location.readOnlyArea.value && mode === 'cut') return;
    if (state.busy.value || !state.snapshot.value || !selected.length || state.section.value === 'trash') return;
    const collectionId = state.snapshot.value.collection.id; const entries = [...selected]; const sourceCapability = state.props.dataSource.capabilities.crossCollectionOperations ?? 'unavailable';

    state.busy.value = true; state.operationError.value = '';
    try { this.browser.explorer.setClipboard(collectionId, sourceCapability, mode, await Promise.all(entries.map(entry => this.captureTarget(entry, collectionId)))) } catch (cause) { state.operationError.value = FilesBrowserState.messageOf(cause) } finally { state.busy.value = false }
  };

  readonly pasteClipboard = async():Promise<void> => { const state = this.browser.state; const clipboard = this.browser.explorer.clipboard; if (!state.snapshot.value || !this.canPaste.value || !clipboard.value) return; const value = clipboard.value; const success = await this.perform(value.mode === 'cut' ? 'move' : 'copy', value.targets.map(target => FilesDropTargets.operationTarget(target, state.currentPath.value)), value.collectionId, value.sourceCapability); if (success && value.mode === 'cut') clipboard.value = null };

  readonly isCut = (entry:DisplayEntry):boolean => { const clipboard = this.browser.explorer.clipboard.value; return clipboard?.mode === 'cut' && clipboard.collectionId === this.browser.state.snapshot.value?.collection.id && clipboard.targets.some(target => target.key === entry.key) };

  readonly downloadSelected = async():Promise<void> => { const state = this.browser.state; const entries = this.browser.selection.selectedEntries.value.filter(entry => !entry.folder); if (!entries.length) return; await this.browser.refresher.runMutation(async() => { const result = await state.props.dataSource.downloadFiles(entries.map(entry => ({ fileId: entry.id, name: entry.name, versionId: entry.currentVersionId }))); if (result.error) state.operationError.value = result.error }, false) };

  readonly trashSelected = async():Promise<void> => {
    const state = this.browser.state; const operations = this.browser.operations; const selected = this.browser.selection.selectedEntries;

    if (this.browser.location.readOnlyArea.value) return;
    if (state.busy.value || state.section.value === 'trash' || !state.props.dataSource.capabilities.trash) return;
    if (operations.supported() && state.props.dataSource.capabilities.folderReceipts) {
      const items:FilesOperationItem[] = selected.value.map(entry => entry.folder ? {
        itemId: crypto.randomUUID(), kind: 'folder', action: 'trash', folderPath: entry.path, expectedFolder: entry.folderState,
      } : {
        itemId: crypto.randomUUID(), kind: 'file', action: 'trash', fileId: entry.id,
        expectedVersionId: entry.currentVersionId, expectedRevision: entry.operationRevision,
      });

      if (items.length) await this.submitReceiptItems(items);
      return;
    }
    const files = new Map<string, FilesItem>();

    if (selected.value.some(entry => entry.folder)) state.operationNotice.value = 'Trash applies to the selected folders’ files. Empty folder metadata is retained; folder Trash is unavailable.';
    try { for (const entry of selected.value) { if (!entry.folder) files.set(entry.id, entry); else for (const file of state.props.dataSource.listFolderTree ? await state.props.dataSource.listFolderTree(entry.path) : this.browser.location.activeFiles.value.filter(file => file.path === entry.path || file.path.startsWith(`${ entry.path }/`))) if (!file.deletedAt) files.set(file.id, file) } } catch (cause) { state.operationError.value = FilesBrowserState.messageOf(cause); return }
    if (!files.size) return;
    if (operations.supported() && selected.value.every(entry => !entry.folder)) {
      await this.submitReceiptItems([...files.values()].map(file => ({ itemId: crypto.randomUUID(), kind: 'file', action: 'trash', fileId: file.id, expectedVersionId: file.currentVersionId, expectedRevision: file.operationRevision })));
      return;
    }
    await this.browser.refresher.runMutation(async() => { for (const file of files.values()) await state.props.dataSource.trashFile(file.id); state.selectedKeys.value = new Set(); this.browser.menus.closeActions(false) });
  };
}
