// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref } from 'vue';

import { FilesDropTargets } from './FilesDropTargets';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry } from './FilesBrowserTypes';
import type { ExplorerTarget } from '../composables/useFilesExplorerInteractions';
import type { FilesCrossCollectionCapability } from '../types';

/** Dragging rows onto folders and the browser, and dropping files from the Mac to upload them. */
export class FilesBrowserDragDrop {
  static readonly HOVER_OPEN_MS = 750;

  readonly dragging = ref(false);
  readonly draggedKeys = ref(new Set<string>());
  readonly dropTargetKey = ref('');
  readonly externalNavigationTarget = ref('');
  readonly dragTargets = ref<ExplorerTarget[]>([]);
  readonly dragPointer = ref({ x: 0, y: 0 });
  readonly favoriteDropActive = ref(false);
  /** Plain fields (not reactive), exactly as before the split: templates read them on the render dragTargets triggers. */
  dragSourceCollectionId = '';
  dragSourceCapability:FilesCrossCollectionCapability = 'unavailable';
  externalDragDepth = 0;
  private internalDragActive = false;
  private hoverOpenTimer:ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly browser:FilesBrowserController) {}

  isExternalFileDrag(event:DragEvent):boolean { return !this.internalDragActive && !event.dataTransfer?.types.includes('application/x-sulla-files') && Boolean(event.dataTransfer?.types.includes('Files')) }

  acceptsExternalDrop(event:DragEvent):boolean { const state = this.browser.state; return this.isExternalFileDrag(event) && state.props.dataSource.capabilities.upload && !this.browser.location.readOnlyArea.value && state.section.value === 'files' }

  readonly onBrowserDragEnter = (event:DragEvent):void => { if (this.acceptsExternalDrop(event)) { this.externalDragDepth++; this.dragging.value = true } };

  readonly onBrowserDragOver = (event:DragEvent):void => { if (this.acceptsExternalDrop(event)) { this.dragging.value = true; this.externalNavigationTarget.value = ''; if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy' } };

  readonly onDragLeave = (_event:DragEvent):void => { if (!this.dragging.value && !this.externalNavigationTarget.value) return; this.externalDragDepth = Math.max(0, this.externalDragDepth - 1); if (!this.externalDragDepth) { this.dragging.value = false; this.externalNavigationTarget.value = '' } };

  readonly onDrop = async(event:DragEvent):Promise<void> => {
    const state = this.browser.state;

    if (this.browser.location.readOnlyArea.value) { this.clearInternalDrag(); return }
    this.dragging.value = false; this.externalDragDepth = 0;
    // A selected file can keep the details pane open while the user drops a
    // file into the browser. Selection is unrelated to drop ownership; aborting
    // here made external uploads silently do nothing whenever details were open.
    if (state.busy.value || state.loading.value || state.section.value !== 'files') { this.clearInternalDrag(); return }
    if (this.dragTargets.value.length) { const targets = this.dragTargets.value.map(target => FilesDropTargets.operationTarget(target, state.currentPath.value)); const sourceCollectionId = this.dragSourceCollectionId; const sourceCapability = this.dragSourceCapability; this.clearInternalDrag(); await this.browser.fileOperations.perform('move', targets, sourceCollectionId, sourceCapability); return }
    if (!event.dataTransfer?.types.includes('Files')) return;
    if (!state.props.dataSource.capabilities.upload) return;
    const files = [...event.dataTransfer.files];

    if (!files.length) return;
    const destination = state.currentPath.value;

    await this.browser.refresher.runMutation(async() => {
      if (state.props.dataSource.uploadDroppedFiles) await state.props.dataSource.uploadDroppedFiles(files, destination);
      else throw new Error('This Files source cannot read dropped files. Use Choose files instead.');
    });
  };

  readonly onEntryDragStart = (entry:DisplayEntry, event:DragEvent):void => {
    const state = this.browser.state; const snapshots = this.browser.dragSnapshots;

    if (this.browser.location.readOnlyArea.value) { event.preventDefault(); return }
    if (state.section.value !== 'files' || state.busy.value || state.loading.value || !event.dataTransfer) { event.preventDefault(); return }
    const entries = snapshots.dragEntriesFor(entry);
    const collectionId = state.snapshot.value?.collection.id;

    if (!collectionId) { event.preventDefault(); return }
    const preparation = snapshots.begin(entries, collectionId, entry.key);
    const missingFolders = entries.filter(item => item.folder && !snapshots.prepared(item, preparation));

    if (missingFolders.length) {
      missingFolders.forEach(item => snapshots.capture(item, preparation).catch(() => undefined));
      state.operationNotice.value = 'Drag within this collection now. Drag again after the exact folder source snapshot is ready to move it to another collection.';
    } else state.operationNotice.value = '';
    this.draggedKeys.value = new Set(entries.map(item => item.key));
    this.internalDragActive = true; this.dragging.value = false; this.externalDragDepth = 0;
    // A running gesture keeps these exact targets; late readiness only serves the next gesture.
    this.dragTargets.value = entries.map(item => item.folder && !missingFolders.length ? snapshots.prepared(item, preparation) ?? FilesDropTargets.toTarget(item) : FilesDropTargets.toTarget(item));
    this.dragSourceCollectionId = collectionId;
    this.dragSourceCapability = missingFolders.length ? 'unavailable' : state.props.dataSource.capabilities.crossCollectionOperations ?? 'unavailable';
    if (!state.selectedKeys.value.has(entry.key)) state.selectedKeys.value = new Set([entry.key]);
    event.dataTransfer.effectAllowed = 'all';
    event.dataTransfer.setData('application/x-sulla-files', JSON.stringify(this.dragTargets.value));
    if (!missingFolders.length) snapshots.invalidate();
  };

  private canDropOnFolder(entry:DisplayEntry, event:DragEvent):boolean { return entry.folder && !this.browser.state.busy.value && (this.draggedKeys.value.size > 0 || this.acceptsExternalDrop(event)) }

  readonly onFolderDragEnter = (entry:DisplayEntry, event:DragEvent):void => { if (this.canDropOnFolder(entry, event)) { event.preventDefault(); event.stopPropagation(); this.dragging.value = false; this.dropTargetKey.value = entry.key; if (this.dragTargets.value.length) this.scheduleHoverOpen(entry) } };

  readonly onFolderDragOver = (entry:DisplayEntry, event:DragEvent):void => { if (this.canDropOnFolder(entry, event)) { event.preventDefault(); event.stopPropagation(); this.dragging.value = false; if (event.dataTransfer) event.dataTransfer.dropEffect = this.dragTargets.value.length ? 'move' : 'copy'; this.dropTargetKey.value = entry.key; this.updateDragPointer(event) } };

  readonly onFolderDragLeave = (entry:DisplayEntry, event:DragEvent):void => { if (this.dropTargetKey.value === entry.key && !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) { this.dropTargetKey.value = ''; this.cancelHoverOpen() } };

  readonly onFolderDrop = async(entry:DisplayEntry, event:DragEvent):Promise<void> => {
    const state = this.browser.state;

    if (!this.canDropOnFolder(entry, event)) return;
    event.preventDefault(); event.stopPropagation();
    if (!this.dragTargets.value.length && event.dataTransfer?.files.length) {
      const files = [...event.dataTransfer.files]; this.dropTargetKey.value = ''; this.dragging.value = false; this.externalDragDepth = 0;

      await this.browser.refresher.runMutation(() => state.props.dataSource.uploadDroppedFiles ? state.props.dataSource.uploadDroppedFiles(files, entry.path) : Promise.reject(new Error('This Desktop build cannot read dropped files.')));
      return;
    }
    const targets = this.dragTargets.value.map(target => FilesDropTargets.operationTarget(target, entry.path)); const sourceCollectionId = this.dragSourceCollectionId; const sourceCapability = this.dragSourceCapability;

    this.clearInternalDrag();
    if (targets.length) await this.browser.fileOperations.perform('move', targets, sourceCollectionId, sourceCapability);
  };

  scheduleHoverOpen(entry:DisplayEntry):void { this.cancelHoverOpen(); this.hoverOpenTimer = setTimeout(() => { if (this.dropTargetKey.value === entry.key && this.dragTargets.value.length) this.browser.navigation.openPath(entry.path) }, FilesBrowserDragDrop.HOVER_OPEN_MS) }

  cancelHoverOpen():void { if (this.hoverOpenTimer) clearTimeout(this.hoverOpenTimer); this.hoverOpenTimer = undefined }

  readonly updateDragPointer = (event:DragEvent):void => { this.dragPointer.value = { x: event.clientX, y: event.clientY } };

  /** Dragging near the top or bottom edge of the main surface scrolls it. */
  readonly onSurfaceDragOver = (event:DragEvent):void => { this.updateDragPointer(event); const surface = this.browser.state.mainSurface.value; if (!surface) return; const rect = surface.getBoundingClientRect(); if (event.clientY < rect.top + 64) surface.scrollTop -= 18; else if (event.clientY > rect.bottom - 64) surface.scrollTop += 18 };

  /** Escape during an external drag hides the drop overlay. */
  cancelExternalDrag():void { this.dragging.value = false; this.externalDragDepth = 0 }

  readonly clearInternalDrag = ():void => { this.externalNavigationTarget.value = ''; this.cancelHoverOpen(); this.internalDragActive = false; this.draggedKeys.value = new Set(); this.dragTargets.value = []; this.dragSourceCollectionId = ''; this.dragSourceCapability = 'unavailable'; this.dropTargetKey.value = ''; this.favoriteDropActive.value = false };
}
