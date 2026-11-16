// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SyntheticFilesStore } from './SyntheticFilesStore';
import { SyntheticValues } from './SyntheticValues';
import type { SyntheticCollection, SyntheticMutation } from './SyntheticFilesTypes';
import type { FolderShare } from '../types';

/** Records what each completed item changed so undo can verify nothing moved since, then put it back. */
export class SyntheticMutationJournal {
  constructor(private readonly store:SyntheticFilesStore) {}

  private folderShareId(share:FolderShare) {
    return share.id ?? [share.collectionId, share.folderPath, share.principalType, share.principalId].join('\0');
  }
  captureMutation(before:SyntheticCollection[], after:SyntheticCollection[], beforeFolderShares:FolderShare[], afterFolderShares:FolderShare[]):SyntheticMutation {
    const beforeFiles = new Map(before.flatMap(collection => collection.files.map(file => [file.id, JSON.stringify([collection.id, file])] as const))); const afterFiles = new Map(after.flatMap(collection => collection.files.map(file => [file.id, JSON.stringify([collection.id, file])] as const))); const beforeFolders = new Map(before.flatMap(collection => collection.folders.map(folder => [folder.folderId, JSON.stringify([collection.id, folder])] as const))); const afterFolders = new Map(after.flatMap(collection => collection.folders.map(folder => [folder.folderId, JSON.stringify([collection.id, folder])] as const)));
    const beforeShares = new Map(beforeFolderShares.map(share => [this.folderShareId(share), JSON.stringify(share)])); const afterShares = new Map(afterFolderShares.map(share => [this.folderShareId(share), JSON.stringify(share)]));

    return {
      before: SyntheticValues.clone(before), after: SyntheticValues.clone(after), beforeFolderShares: SyntheticValues.clone(beforeFolderShares), afterFolderShares: SyntheticValues.clone(afterFolderShares),
      fileIds: [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].filter(id => beforeFiles.get(id) !== afterFiles.get(id)),
      folderIds: [...new Set([...beforeFolders.keys(), ...afterFolders.keys()])].filter(id => beforeFolders.get(id) !== afterFolders.get(id)),
      folderShareIds: [...new Set([...beforeShares.keys(), ...afterShares.keys()])].filter(id => beforeShares.get(id) !== afterShares.get(id)),
    };
  }
  private locatedItem(collections:SyntheticCollection[], kind:'file' | 'folder', id:string) {
    for (const collection of collections) {
      const item = kind === 'file' ? collection.files.find(file => file.id === id) : collection.folders.find(folder => folder.folderId === id);

      if (item) return { collectionId: collection.id, item };
    }
  }
  private namespaceOwners(collections:SyntheticCollection[], collectionId:string, path:string, descendants:boolean) {
    const collection = collections.find(value => value.id === collectionId);

    if (!collection) return null;
    const ownsPath = (candidate:string) => candidate === path || descendants && candidate.startsWith(path + '/');

    return [
      ...collection.files.filter(file => ownsPath(file.path)).map(file => 'file:' + file.id),
      ...collection.folders.filter(folder => ownsPath(folder.path)).map(folder => 'folder:' + folder.folderId),
    ].sort();
  }
  mutationMatches(mutation:SyntheticMutation, side:'before' | 'after') {
    const snapshot = mutation[side];
    const matchesItem = (kind:'file' | 'folder', id:string) => {
      const current = this.locatedItem(this.store.state.collections, kind, id); const saved = this.locatedItem(snapshot, kind, id);

      return JSON.stringify(current) === JSON.stringify(saved);
    };
    const guards = new Map<string, { collectionId:string; path:string; descendants:boolean }>();
    const addGuard = (kind:'file' | 'folder', id:string) => {
      for (const collections of [mutation.before, mutation.after]) {
        const located = this.locatedItem(collections, kind, id);

        if (!located) continue;
        const path = located.item.path; const descendants = kind === 'folder'; const key = [located.collectionId, path, descendants ? 'tree' : 'item'].join('\0');

        guards.set(key, { collectionId: located.collectionId, path, descendants });
      }
    };

    mutation.fileIds.forEach(id => addGuard('file', id)); mutation.folderIds.forEach(id => addGuard('folder', id));

    return mutation.fileIds.every(id => matchesItem('file', id)) && mutation.folderIds.every(id => matchesItem('folder', id)) &&
      mutation.folderShareIds.every(id => JSON.stringify(this.store.folderShares.find(share => this.folderShareId(share) === id)) === JSON.stringify(mutation[side === 'before' ? 'beforeFolderShares' : 'afterFolderShares'].find(share => this.folderShareId(share) === id))) &&
      [...guards.values()].every(guard => JSON.stringify(this.namespaceOwners(this.store.state.collections, guard.collectionId, guard.path, guard.descendants)) === JSON.stringify(this.namespaceOwners(snapshot, guard.collectionId, guard.path, guard.descendants)));
  }
  applyMutation(mutation:SyntheticMutation, side:'before' | 'after') {
    for (const collection of this.store.state.collections) { collection.files = collection.files.filter(file => !mutation.fileIds.includes(file.id)); collection.folders = collection.folders.filter(folder => !mutation.folderIds.includes(folder.folderId)) }
    for (const saved of mutation[side]) {
      const collection = this.store.collection(saved.id);

      collection.files.push(...SyntheticValues.clone(saved.files.filter(file => mutation.fileIds.includes(file.id))));
      collection.folders.push(...SyntheticValues.clone(saved.folders.filter(folder => mutation.folderIds.includes(folder.folderId))));
    }
    this.store.folderShares = this.store.folderShares.filter(share => !mutation.folderShareIds.includes(this.folderShareId(share)));
    this.store.folderShares.push(...SyntheticValues.clone(mutation[side === 'before' ? 'beforeFolderShares' : 'afterFolderShares'].filter(share => mutation.folderShareIds.includes(this.folderShareId(share)))));
  }
}
