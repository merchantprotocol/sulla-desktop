// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isFilesFolderReplacementDestination, isFilesOperationState } from '../types';
import { SyntheticFilesFixtures } from './SyntheticFilesFixtures';
import { SyntheticValues } from './SyntheticValues';
import type { SyntheticCollection, SyntheticState } from './SyntheticFilesTypes';
import type { FileShare, FilesCollisionDestination, FilesFolderReplacementDestination, FilesFolderSourceSnapshot, FilesFolderState, FilesItem, FilesOperationState, FolderShare } from '../types';

/** The synthetic preview state for one data source: collections, receipts, stars and shares, persisted per browser session. */
export class SyntheticFilesStore {
  // Synthetic operation state is deliberately scoped to this browser session.
  private static readonly STORAGE_KEY = 'sulla:files:synthetic-receipt-preview:v4';

  state:SyntheticState;
  fileShares:FileShare[];

  constructor(readonly fixtures = new SyntheticFilesFixtures(), private readonly storageSuffix = '') {
    this.fileShares = fixtures.fileShares();
    this.state = this.restoreState() ?? fixtures.initialState();
  }

  get folderShares():FolderShare[] { return this.state.folderShares }
  set folderShares(value:FolderShare[]) { this.state.folderShares = value }

  iso(days = 0):string { return this.fixtures.iso(days) }

  restoreState():SyntheticState | null {
    try {
      const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SyntheticFilesStore.STORAGE_KEY + this.storageSuffix);
      const value = raw ? JSON.parse(raw) as SyntheticState : null;

      return value?.collections?.some(item => item.id === value.selectedCollectionId) && value.operations && value.idempotency && value.folderReceipts && Array.isArray(value.folderShares) && typeof value.staleReplaceAdvanced === 'boolean' ? value : null;
    } catch { return null }
  }
  persist() {
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SyntheticFilesStore.STORAGE_KEY + this.storageSuffix, JSON.stringify(this.state)) }
    catch { /* In-memory behavior remains available if session storage is unavailable. */ }
  }
  collection(id:string) {
    const result = this.state.collections.find(item => item.id === id);

    if (!result) throw new Error('Synthetic collection is no longer available');
    return result;
  }
  currentCollection() { return this.collection(this.state.selectedCollectionId) }
  nextRevision() { return String(++this.state.revision) }
  nextId(prefix:string) { return prefix + '-' + (++this.state.sequence) + '-' + crypto.randomUUID() }
  normalizePath(path:string) {
    const value = path.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');

    if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Synthetic operation path is invalid');
    return value;
  }
  fileState(file:FilesItem, collectionId:string):FilesOperationState {
    return { collectionId, fileId: file.id, path: file.path, versionId: file.currentVersionId, revision: file.operationRevision ?? '0', deleted: Boolean(file.deletedAt) };
  }
  sameFileState(a?:FilesCollisionDestination, b?:FilesCollisionDestination) {
    return isFilesOperationState(a) && isFilesOperationState(b) && a.collectionId === b.collectionId && a.fileId === b.fileId && a.path === b.path && a.versionId === b.versionId && a.revision === b.revision && a.deleted === b.deleted;
  }
  folderState(folder:FilesFolderState, collectionId:string):FilesFolderState {
    return { collectionId, folderId: folder.folderId, path: folder.path, revision: folder.revision, description:folder.description, namingHint:folder.namingHint, needsDescription:folder.needsDescription };
  }
  sameFolderState(a?:FilesFolderState, b?:FilesFolderState) {
    return Boolean(a && b && a.collectionId === b.collectionId && a.folderId === b.folderId && a.path === b.path && a.revision === b.revision);
  }
  sameFolderReplacementDestination(a?:FilesCollisionDestination, b?:FilesCollisionDestination) {
    return isFilesFolderReplacementDestination(a) && isFilesFolderReplacementDestination(b) && this.sameFolderState(a, b) && a.subtreeSignature === b.subtreeSignature;
  }
  folderSourceSnapshot(collection:SyntheticCollection, path:string):FilesFolderSourceSnapshot {
    const root = this.activeFolderAt(collection, path);
    const files = collection.files.filter(file => !file.deletedAt && file.path.startsWith(path + '/')).sort((a, b) => a.path.localeCompare(b.path));
    const folders = collection.folders.filter(folder => !folder.deletedAt && (folder.path === path || folder.path.startsWith(path + '/'))).sort((a, b) => a.path.localeCompare(b.path));
    const fileIds = new Set(files.map(file => file.id));
    const folderShares = this.folderShares.filter(share => share.collectionId === collection.id && (share.folderPath === path || share.folderPath.startsWith(path + '/'))).map(share => SyntheticValues.clone(share)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const fileShares = this.fileShares.filter(share => fileIds.has(share.fileId)).map(share => SyntheticValues.clone(share)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const subtreeSignature = SyntheticValues.sha256(SyntheticValues.canonical({
      files: files.map(file => ({ id: file.id, path: file.path, versionId: file.currentVersionId, revision: file.operationRevision ?? '0', deleted: false })),
      folders: folders.map(folder => this.folderState(folder, collection.id)),
      folderShares,
      publicLinks: [],
      fileSharesSignature: SyntheticValues.sha256(SyntheticValues.canonical(fileShares)),
      fileLinksSignature: SyntheticValues.sha256(SyntheticValues.canonical([])),
      nativeSignature: SyntheticValues.sha256(SyntheticValues.canonical({ files: [], directories: [] })),
    }));

    return { collectionId: collection.id, path, ...(root ? { folderId: root.folderId, revision: root.revision } : {}), subtreeSignature };
  }
  folderReplacementDestination(collection:SyntheticCollection, path:string):FilesFolderReplacementDestination | undefined {
    const snapshot = this.folderSourceSnapshot(collection, path);

    return snapshot.folderId && snapshot.revision ? { collectionId: snapshot.collectionId, folderId: snapshot.folderId, path: snapshot.path, revision: snapshot.revision, subtreeSignature: snapshot.subtreeSignature } : undefined;
  }
  activeFileAt(collection:SyntheticCollection, path:string, ignored = new Set<string>()) { return collection.files.find(file => !file.deletedAt && file.path === path && !ignored.has(file.id)) }
  activeFolderAt(collection:SyntheticCollection, path:string, ignored = new Set<string>()) { return collection.folders.find(folder => !folder.deletedAt && folder.path === path && !ignored.has(folder.folderId)) }
  keepBothPath(collection:SyntheticCollection, requested:string, ignoredFiles = new Set<string>(), ignoredFolders = new Set<string>()) {
    const slash = requested.lastIndexOf('/'); const parent = slash < 0 ? '' : requested.slice(0, slash); const name = slash < 0 ? requested : requested.slice(slash + 1); const dot = name.lastIndexOf('.'); const stem = dot > 0 ? name.slice(0, dot) : name; const extension = dot > 0 ? name.slice(dot) : '';

    for (let number = 1; number < 1_000; number++) {
      const suffix = number === 1 ? ' copy' : ' copy ' + number; const candidate = [parent, stem + suffix + extension].filter(Boolean).join('/');

      if (!this.activeFileAt(collection, candidate, ignoredFiles) && !this.activeFolderAt(collection, candidate, ignoredFolders)) return candidate;
    }
    throw new Error('Synthetic Keep Both could not reserve a destination');
  }
}
