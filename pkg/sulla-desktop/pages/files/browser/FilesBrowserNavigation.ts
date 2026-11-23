// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DURABLE_FILE_ID_PATTERN } from '@pkg/shared/filesReferences';

import { supportsDocumentEditor } from '../editor/editorTypes';
import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry, FilesBrowserSection } from './FilesBrowserTypes';
import type { ExplorerLocation } from '../composables/useFilesExplorerInteractions';
import type { FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';
import type { FilesItem } from '../types';

/** Moving between collections, sections and folders, back/forward history and opening an entry. */
export class FilesBrowserNavigation {
  private requestGeneration = 0;
  private consumedNavigation?:FilesNavigationPayload;

  constructor(private readonly browser:FilesBrowserController) {}

  private get state():FilesBrowserState { return this.browser.state }

  readonly selectCollection = async(collectionId:string):Promise<void> => {
    const state = this.state; const browser = this.browser;

    if (collectionId === state.snapshot.value?.collection.id && state.collectionsRoot.value && state.section.value === 'files') { this.navigate({ ...this.currentLocation(), section: 'files', path: '' }); return }
    if (state.busy.value || state.loading.value || !state.props.dataSource.selectCollection || collectionId === state.snapshot.value?.collection.id) return;
    if (!browser.dragDrop.dragTargets.value.length) browser.dragDrop.clearInternalDrag();
    browser.rename.cancelRename(); browser.quickLook.closeQuickLook();
    browser.gestures.stopPointerGesture?.(); browser.menus.closeActions(false); browser.menus.closeBackgroundActions(); state.query.value = ''; browser.search.generation++;
    state.props.dataSource.selectCollection(collectionId); state.collectionsRoot.value = false; state.section.value = 'files'; state.currentPath.value = ''; state.selected.value = null; state.searchResults.value = null; state.searchCoverage.value = null; state.selectedKeys.value = new Set();
    await browser.refresher.refresh();
    browser.explorer.clearForCollection(collectionId); browser.preferences.loadFolderPreferences();
  };

  currentLocation():ExplorerLocation { return { collectionId: this.state.snapshot.value?.collection.id ?? '', section: this.state.section.value, path: this.state.currentPath.value } }

  private applyLocation(location:ExplorerLocation):void {
    const state = this.state; const browser = this.browser;

    if (state.busy.value || state.loading.value) return;
    browser.gestures.stopPointerGesture?.(); browser.rename.cancelRename(); browser.quickLook.closeQuickLook();
    if (location.collectionId && location.collectionId !== state.snapshot.value?.collection.id && state.props.dataSource.selectCollection) state.props.dataSource.selectCollection(location.collectionId);
    browser.menus.closeActions(false); browser.menus.closeBackgroundActions(); state.selectionAnchor.value = null; state.collectionsRoot.value = false; state.section.value = location.section as FilesBrowserSection; state.currentPath.value = location.path; state.query.value = ''; state.searchResults.value = null; state.selected.value = null; state.selectedKeys.value = new Set(); browser.preferences.loadFolderPreferences();
  }

  navigate(location:ExplorerLocation, track = true):void { if (this.state.busy.value || this.state.loading.value) return; const current = this.currentLocation(); if (track) this.browser.explorer.visit(current, location); this.applyLocation(location) }

  readonly selectSection = (next:FilesBrowserSection):void => { this.navigate({ ...this.currentLocation(), section: next, path: '' }) };

  readonly openRoot = ():void => { this.navigate({ ...this.currentLocation(), section: 'files', path: '' }) };

  readonly openHome = ():void => {
    const state = this.state; const collections = this.browser.location.userCollections.value;

    if (collections.length > 1) { if (state.busy.value || state.loading.value) return; this.selectSection('files'); state.collectionsRoot.value = true; return }
    const home = collections[0];

    if (home && state.snapshot.value?.collection.id !== home.id) void this.selectCollection(home.id); else this.selectSection('files');
  };

  readonly openPath = (next:string):void => { this.navigate({ ...this.currentLocation(), section: 'files', path: next }) };

  readonly openParent = ():void => { if (!this.state.currentPath.value && this.browser.location.collectionCrumb.value) this.openHome(); else this.openPath(this.browser.location.parentPath.value) };

  readonly goBack = ():void => { if (this.state.busy.value || this.state.loading.value) return; const location = this.browser.explorer.back(this.currentLocation()); if (location) this.applyLocation(location) };

  readonly goForward = ():void => { if (this.state.busy.value || this.state.loading.value) return; const location = this.browser.explorer.forward(this.currentLocation()); if (location) this.applyLocation(location) };

  /** Mouse buttons 4 and 5 (back/forward) on the main surface. */
  readonly onMouseNavigation = (event:MouseEvent):void => { if (event.button === 3) { event.preventDefault(); this.goBack() } else if (event.button === 4) { event.preventDefault(); this.goForward() } };

  /** Double-click / Enter on a row: open a collection or folder, edit a document, or show details. */
  readonly activate = (entry:DisplayEntry):void => {
    const state = this.state;

    if (entry.rootCollectionId) { void this.selectCollection(entry.rootCollectionId); return }
    if (state.section.value === 'trash') { state.selectedKeys.value = new Set([entry.key]); if (!entry.folder) this.selectEntry(entry); return }
    if (entry.folder) this.openPath(entry.path); else if (supportsDocumentEditor(entry.path)) state.emit('open-editor', entry, state.snapshot.value?.collection.id); else this.selectEntry(entry);
  };

  readonly selectEntry = (entry:DisplayEntry):void => {
    const state = this.state;

    if (entry.rootCollectionId) { void this.selectCollection(entry.rootCollectionId); return }
    if (state.busy.value || state.loading.value) return;
    this.browser.gestures.stopPointerGesture?.(); this.browser.rename.cancelRename();
    if (entry.folder) { this.openPath(entry.path); return }
    state.detailVersion.value = undefined;
    state.selected.value = entry; state.detailTab.value = this.browser.presenter.entrySync(entry) === 'conflict' ? 'versions' : 'details';
  };

  readonly openDisplayEntry = (entry:DisplayEntry):void => { if (supportsDocumentEditor(entry.path)) this.state.emit('open-editor', entry, this.state.snapshot.value?.collection.id); else this.selectEntry(entry) };

  /** FileDetail's close button returns to the listing. */
  readonly closeDetail = ():void => { this.state.selected.value = null };

  /** FileDetail restored a version: back to the listing and reload it. */
  readonly onDetailRestored = ():void => { this.state.selected.value = null; void this.browser.refresher.refresh(true) };

  /** FileDetail's "Open" button. */
  readonly openDetail = async():Promise<void> => {
    const { selected, detailVersion, navigationError } = this.state;
    if (!selected.value) return;
    if (!detailVersion.value) { this.openDisplayEntry(selected.value); return }
    navigationError.value = '';
    try {
      await this.state.props.dataSource.openFile(selected.value.id, detailVersion.value.id);
    } catch {
      navigationError.value = 'Couldn’t open that file version. Check your Files access and try again.';
    }
  };

  readonly openLinked = async(fileId:string, path:string):Promise<void> => {
    const state = this.state; const source = state.props.dataSource;
    let file = state.snapshot.value?.files.find(item => item.id === fileId);

    if (!file) {
      // Only the open folder is loaded, so resolve the linked file by id wherever it lives.
      try { if (source.filesByIds) file = (await source.filesByIds([fileId]))[0]; else { const loaded = await source.load(); state.snapshot.value = loaded; file = loaded.files.find(item => item.id === fileId) } } catch (cause) { state.operationError.value = FilesBrowserState.messageOf(cause); return }
    }
    if (file) this.openDisplayEntry(this.browser.factory.toDisplay(file));
    else state.operationError.value = `The linked file ${ path.split('/').at(-1) || path } is no longer available.`;
  };

  /** Resolve a viewer open by identity first, then through the authorized listing of its parent folder. */
  private async resolveOpenFile(fileId?:string, path?:string):Promise<FilesItem | null> {
    const state = this.state; const source = state.props.dataSource;
    const cached = state.snapshot.value?.files.find(item => !item.deletedAt
      && (fileId ? item.id === fileId : item.path === path));
    if (cached) return cached;

    if (fileId && source.filesByIds) {
      try {
        const file = (await source.filesByIds([fileId])).find(item => item.id === fileId && !item.deletedAt);
        if (file) return file;
      } catch { /* A failed ID lookup can still be resolved by the authorized folder listing below. */ }
    }
    if (!path) return null;

    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    if (source.loadFolder) {
      try {
        const file = (await source.loadFolder(parent)).find(item => item.path === path && !item.deletedAt);
        if (file) return file;
      } catch { /* Try the complete child listing when the first folder page fails. */ }
    }
    if (source.listFolderChildren) {
      try {
        const file = (await source.listFolderChildren(parent)).find(item => item.path === path && !item.deletedAt);
        if (file) return file;
      } catch { /* The caller reports an actionable error if resolution remains unavailable. */ }
    }
    return null;
  }

  /** Apply a navigation request handed in through the `navigation` prop. */
  async navigateTo(detail:FilesNavigationPayload):Promise<boolean> {
    const state = this.state; const browser = this.browser;

    const generation = ++this.requestGeneration;
    const source = state.props.dataSource;
    const isCurrent = () => state.mounted && generation === this.requestGeneration && source === state.props.dataSource;
    const fail = (message:string):false => { if (isCurrent()) state.navigationError.value = message; return false };
    state.navigationError.value = '';
    browser.sharing.closeShare();

    if (detail.section === 'shared-by-me') { this.selectSection('sharedByMe'); return true }
    const isFileOpen = detail.openKind === 'file';
    if (isFileOpen) {
      if (detail.fileId !== undefined && !DURABLE_FILE_ID_PATTERN.test(detail.fileId)) return fail('This Files reference is invalid. Ask for a fresh reference.');
      if (detail.collectionId && detail.collectionId !== state.snapshot.value?.collection.id) {
        await this.selectCollection(detail.collectionId);
        if (!isCurrent()) return false;
        if (detail.collectionId !== state.snapshot.value?.collection.id) return fail('This Files collection could not be opened. Check your access and try again.');
      }
      if (state.busy.value || state.loading.value) return fail('Files is busy. Wait for it to finish, then try the reference again.');

      const file = await this.resolveOpenFile(detail.fileId, detail.path);
      if (!isCurrent()) return false;
      if (!file) return fail('This file is no longer available at that path. Check your Files access and try again.');

      const slash = file.path.lastIndexOf('/');
      const parent = slash < 0 ? '' : file.path.slice(0, slash);
      this.openPath(parent);
      if (state.section.value !== 'files' || state.currentPath.value !== parent || state.busy.value || state.loading.value) {
        return fail('Files could not open the file’s folder. Wait for it to finish, then try again.');
      }
      this.selectEntry(browser.factory.toDisplay(file));
      if (state.selected.value?.id !== file.id) return fail('Files could not select the requested file. Check your access and try again.');
      return true;
    }
    if (detail.fileId === undefined && detail.versionId === undefined) {
      if (detail.collectionId && detail.collectionId !== state.snapshot.value?.collection.id) await this.selectCollection(detail.collectionId);
      if (!isCurrent()) return false;
      if (detail.path === undefined) return fail('This Files destination is missing. Open Files and try again.');
      if (state.busy.value || state.loading.value) return fail('Files is busy. Wait for it to finish, then try again.');
      this.openPath(detail.path);
      if (state.section.value !== 'files' || state.currentPath.value !== detail.path) return fail('Files could not open that folder. Check your access and try again.');
      if (detail.section === 'share-review') browser.sharing.shareCurrentFolder();
      return true;
    }

    const { fileId, versionId } = detail;
    if (!fileId || !DURABLE_FILE_ID_PATTERN.test(fileId) || (versionId !== undefined && !DURABLE_FILE_ID_PATTERN.test(versionId))) {
      return fail('This Files reference is invalid. Ask for a fresh reference.');
    }
    try {
      // Always ask the authorized metadata endpoint: path and cached folder rows
      // aren't proof of identity or of the current user's visible version.
      const metadata = await source.detail(fileId);
      if (!isCurrent()) return false;
      const file = metadata.item;
      if (!file || file.id !== fileId || file.deletedAt || !file.currentVersionId
          || (detail.collectionId && metadata.collectionId && detail.collectionId !== metadata.collectionId)) {
        return fail('This file is no longer available. Ask for a fresh reference or check your Files access.');
      }
      const collectionId = metadata.collectionId ?? detail.collectionId;
      if (collectionId && collectionId !== state.snapshot.value?.collection.id) {
        await this.selectCollection(collectionId);
        if (!isCurrent()) return false;
        if (collectionId !== state.snapshot.value?.collection.id) {
          return fail('This Files collection could not be opened. Check your access and try again.');
        }
      }
      const version = versionId
        ? (await source.history(fileId, file.currentVersionId)).find(entry => entry.id === versionId && !entry.deleted
          && (entry.publicationStatus !== 'draft' || metadata.capabilities?.canViewDraft || entry.id === file.currentVersionId))
        : undefined;
      if (!isCurrent()) return false;
      if (versionId && !version) {
        return fail('This file version is no longer available or you don’t have access. Ask for a fresh reference.');
      }

      if (detail.section === 'share-review') {
        const available = await (source.publicLinksAvailable?.() ?? source.capabilities.publicLinks);
        if (!isCurrent()) return false;
        if (!available || !source.createPublicLink || !state.snapshot.value) {
          return fail('Link review is unavailable. Check your Files sharing access and Sulla Cloud connection, then try again.');
        }
      }
      if (state.busy.value || state.loading.value) return fail('Files is busy. Wait for it to finish, then try the reference again.');

      state.collectionsRoot.value = false;
      const entry = browser.factory.toDisplay(file);
      if (!detail.section && !version && supportsDocumentEditor(file.path)) { state.emit('open-editor', entry, collectionId); return true }
      this.selectEntry(entry);
      state.detailTab.value = detail.section === 'versions' ? 'versions' : 'details';
      if (detail.section === 'detail' || (!detail.section && version)) state.detailVersion.value = version;
      if (detail.section === 'share-review') browser.sharing.shareEntry(entry);
      if (state.selected.value?.id !== file.id) return fail('Files could not select the requested file. Check your access and try again.');
      return true;
    } catch {
      return fail('Couldn’t read this Files reference. Check your connection and access, then try again or ask for a fresh reference.');
    }
  }

  private emitNavigationResult(request:FilesNavigationPayload, opened:boolean):void {
    if (!request.openRequestId) return;
    const kind = request.openKind ?? (request.fileId ? 'file' : 'folder');
    const path = opened
      ? (kind === 'file' ? this.state.selected.value?.path ?? request.path ?? '' : this.state.currentPath.value)
      : request.path ?? '';
    this.state.emit('navigation-result', {
      requestId: request.openRequestId,
      opened,
      path,
      kind,
      ...(opened ? {} : { error: this.state.navigationError.value || 'The requested Files item could not be opened.' }),
    });
  }

  readonly consumeNavigation = ():void => {
    const state = this.state;
    const request = state.props.navigation;
    if (!request) { this.consumedNavigation = undefined; return }
    if (!state.mounted || state.busy.value || state.loading.value || this.consumedNavigation === request) return;
    if (!state.snapshot.value) {
      if (state.error.value && (request.fileId !== undefined || request.versionId !== undefined || request.openRequestId !== undefined)) {
        state.navigationError.value = request.openKind === 'folder'
          ? 'Couldn’t open this Files folder because Files didn’t load. Check your connection and access, then try again.'
          : 'Couldn’t open this file reference because Files didn’t load. Check your connection and access, then try again.';
        if (request.openRequestId) this.emitNavigationResult(request, false);
      }
      // Keep the request pending so the Files retry can replay it after a successful load.
      return;
    }
    this.consumedNavigation = request;
    void this.navigateTo(request).then(opened => this.emitNavigationResult(request, opened)).catch(() => {
      state.navigationError.value = 'Couldn’t open this Files item. Check your connection and access, then try again.';
      this.emitNavigationResult(request, false);
    });
    state.emit('navigation-consumed');
  };
}
