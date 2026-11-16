// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesDropTargets } from './FilesDropTargets';

import type { FilesBrowserController } from './FilesBrowserController';

/** Drop targets outside the listing: sidebar collections, Favorites, sidebar folders, breadcrumbs and "Up". */
export class FilesBrowserDropZones {
  constructor(private readonly browser:FilesBrowserController) {}

  private get drag() { return this.browser.dragDrop }

  readonly setCollectionDropEffect = (event:DragEvent):void => { if (event.dataTransfer) event.dataTransfer.dropEffect = 'move' };

  readonly onCollectionDrop = async(collectionId:string, event:DragEvent):Promise<void> => {
    const state = this.browser.state; const drag = this.drag;

    if (state.busy.value || state.loading.value || !drag.dragTargets.value.length || collectionId === state.snapshot.value?.collection.id) return;
    if (!FilesDropTargets.canLeaveCollection(drag.dragTargets.value, drag.dragSourceCapability)) { drag.clearInternalDrag(); state.operationError.value = 'Moving between collections is not available for this selection, so nothing was moved.'; return }
    const targets = [...drag.dragTargets.value]; const sourceCollectionId = drag.dragSourceCollectionId; const sourceCapability = drag.dragSourceCapability;

    event.stopPropagation();
    await this.browser.navigation.selectCollection(collectionId);
    if (state.snapshot.value?.collection.id !== collectionId || state.section.value !== 'files' || state.currentPath.value !== '') {
      drag.clearInternalDrag();
      state.operationError.value = 'The destination collection did not finish loading, so nothing was moved.';
      return;
    }
    const items = targets.map(target => FilesDropTargets.operationTarget(target, ''));

    drag.clearInternalDrag();
    await this.browser.fileOperations.perform('move', items, sourceCollectionId, sourceCapability);
  };

  private canFavoriteDrag():boolean {
    const state = this.browser.state; const drag = this.drag;

    return !state.busy.value && !state.loading.value && Boolean(state.snapshot.value?.collection.id) && drag.dragSourceCollectionId === state.snapshot.value?.collection.id && drag.draggedKeys.value.size > 0 && drag.dragTargets.value.length > 0 && drag.dragTargets.value.every(target => target.folder && Boolean(target.folderPath));
  }

  readonly onFavoriteDragEnter = (event:DragEvent):void => {
    event.preventDefault(); event.stopPropagation(); this.drag.cancelHoverOpen();
    this.drag.favoriteDropActive.value = this.canFavoriteDrag();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.drag.favoriteDropActive.value ? 'link' : 'none';
  };

  readonly onFavoriteDragOver = (event:DragEvent):void => {
    event.preventDefault(); event.stopPropagation(); this.drag.cancelHoverOpen();
    this.drag.favoriteDropActive.value = this.canFavoriteDrag();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.drag.favoriteDropActive.value ? 'link' : 'none';
  };

  readonly onFavoriteDragLeave = (event:DragEvent):void => {
    event.stopPropagation();
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) this.drag.favoriteDropActive.value = false;
  };

  readonly onFavoriteDrop = async(event:DragEvent):Promise<void> => {
    const state = this.browser.state; const drag = this.drag;

    event.preventDefault(); event.stopPropagation(); drag.cancelHoverOpen();
    const collectionId = state.snapshot.value?.collection.id;
    const paths = this.canFavoriteDrag() ? [...new Set(drag.dragTargets.value.map(target => target.folderPath!).filter(Boolean))] : [];

    drag.clearInternalDrag();
    if (!collectionId || !paths.length || state.busy.value || state.loading.value) return;
    const additions = paths.filter(path => !state.starred.value.has(`folder:${ path }`));

    if (!additions.length) return;
    await this.browser.refresher.runMutation(async() => {
      for (const folderPath of additions) await state.props.dataSource.setStar(collectionId, { folderPath }, true);
    });
  };

  readonly onNavigationDragOver = (path:string, event:DragEvent):void => { const drag = this.drag; if (!drag.dragTargets.value.length && !drag.acceptsExternalDrop(event)) return; event.stopPropagation(); drag.externalNavigationTarget.value = path; if (event.dataTransfer) event.dataTransfer.dropEffect = drag.dragTargets.value.length ? 'move' : 'copy'; drag.updateDragPointer(event) };

  readonly onNavigationDrop = async(path:string, event:DragEvent):Promise<void> => {
    const state = this.browser.state; const drag = this.drag;

    if (!drag.dragTargets.value.length && !drag.acceptsExternalDrop(event)) return;
    event.stopPropagation(); drag.externalNavigationTarget.value = '';
    if (!drag.dragTargets.value.length && event.dataTransfer?.files.length) { const files = [...event.dataTransfer.files]; await this.browser.refresher.runMutation(() => state.props.dataSource.uploadDroppedFiles ? state.props.dataSource.uploadDroppedFiles(files, path) : Promise.reject(new Error('This Desktop build cannot read dropped files.'))); return }
    const targets = drag.dragTargets.value.map(target => FilesDropTargets.operationTarget(target, path)); const sourceCollectionId = drag.dragSourceCollectionId; const sourceCapability = drag.dragSourceCapability;

    drag.clearInternalDrag(); await this.browser.fileOperations.perform('move', targets, sourceCollectionId, sourceCapability);
  };
}
