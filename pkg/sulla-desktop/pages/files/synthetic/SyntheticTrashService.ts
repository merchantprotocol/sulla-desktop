// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SyntheticFilesStore } from './SyntheticFilesStore';
import type { SyntheticCollection, SyntheticFile, SyntheticFolder, SyntheticFolderReceiptPlan, SyntheticTrashState } from './SyntheticFilesTypes';
import type { FilesTrashItem, FilesTrashPurgeResult, FilesTrashRestoreResult } from '../types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

/** Trash, restore and purge for the preview, with the same revision and tombstone CAS refusals as the service. */
export class SyntheticTrashService {
  constructor(private readonly store:SyntheticFilesStore) {}

  private trashConflict(message:string):never { throw Object.assign(new Error(message), { status: 409, code: 'trash-state-conflict' }) }
  private exactTrashState(actual:SyntheticTrashState | undefined, item:FilesTrashItem, currentRevision:string) {
    return Boolean(actual?.listed && actual.revision === item.revision && currentRevision === item.revision && JSON.stringify(actual.tombstone) === JSON.stringify(item.currentTombstone));
  }
  private receiptMembers(collection:SyntheticCollection, receiptId:string) {
    const plan = this.store.state.folderReceipts[receiptId];
    const files = plan?.files.map(member => collection.files.find(file => file.id === member.id)).filter((file):file is SyntheticFile => Boolean(file)) ?? [];
    const folders = plan?.folders.map(member => collection.folders.find(folder => folder.folderId === member.id)).filter((folder):folder is SyntheticFolder => Boolean(folder)) ?? [];
    const exact = Boolean(plan && plan.collectionId === collection.id && files.length === plan.files.length && folders.length === plan.folders.length &&
      plan.folders.some(member => member.id === plan.rootFolderId && member.path === plan.rootPath) &&
      plan.files.every(member => {
        const file = files.find(candidate => candidate.id === member.id);

        return Boolean(file?.deletedAt && file.path === member.path && file.operationRevision === member.revision && file.syntheticTrash?.revision === member.revision && file.syntheticTrash.parentReceiptId === receiptId && file.syntheticTrash.tombstone.receiptId === member.receiptId);
      }) && plan.folders.every(member => {
        const folder = folders.find(candidate => candidate.folderId === member.id);

        return Boolean(folder?.deletedAt && folder.path === member.path && folder.revision === member.revision && folder.syntheticTrash?.revision === member.revision && folder.syntheticTrash.parentReceiptId === receiptId && folder.syntheticTrash.tombstone.receiptId === receiptId);
      }));
    const expectedFiles = new Set(plan?.files.map(member => member.id) ?? []); const expectedFolders = new Set(plan?.folders.map(member => member.id) ?? []);
    const inNamespace = (path:string) => Boolean(plan && (path === plan.rootPath || path.startsWith(plan.rootPath + '/')));
    const namespaceExact = Boolean(plan && collection.files.filter(file => inNamespace(file.path)).every(file => expectedFiles.has(file.id)) &&
      collection.folders.filter(folder => inNamespace(folder.path)).every(folder => expectedFolders.has(folder.folderId)));

    return { files, folders, exact, namespaceExact, plan };
  }
  private folderRestoreNamespaceOccupied(collection:SyntheticCollection, plan:SyntheticFolderReceiptPlan) {
    const expectedFiles = new Set(plan.files.map(member => member.id)); const expectedFolders = new Set(plan.folders.map(member => member.id));
    const inNamespace = (path:string) => path === plan.rootPath || path.startsWith(plan.rootPath + '/');

    return collection.files.some(file => !file.deletedAt && inNamespace(file.path) && !expectedFiles.has(file.id)) ||
      collection.folders.some(folder => !folder.deletedAt && inNamespace(folder.path) && !expectedFolders.has(folder.folderId));
  }
  async restoreTrashItem(item:FilesTrashItem):Promise<FilesTrashRestoreResult> {
    const collection = this.store.currentCollection();

    if (item.kind === 'file') {
      const file = collection.files.find(candidate => candidate.id === item.id);

      if (!file?.deletedAt || !this.exactTrashState(file.syntheticTrash, item, file.operationRevision ?? '0')) this.trashConflict('Synthetic restore was blocked because the file revision or current tombstone changed.');
      if (this.store.activeFileAt(collection, file.path, new Set([file.id])) || this.store.activeFolderAt(collection, file.path)) this.trashConflict('Synthetic restore was blocked because the original path is occupied.');
      const receiptId = file.syntheticTrash!.tombstone.receiptId ?? null;

      file.deletedAt = undefined; file.syntheticTrash = undefined; file.updatedAt = new Date().toISOString(); file.operationRevision = this.store.nextRevision(); this.store.persist();
      return { status: 'restored', kind: 'file', id: file.id, path: file.path, revision: file.operationRevision, currentTombstone: null, receiptId, versionId: file.currentVersionId };
    }
    const folder = collection.folders.find(candidate => candidate.folderId === item.id); const receiptId = folder?.syntheticTrash?.tombstone.receiptId;

    if (!folder?.deletedAt || !receiptId || !this.exactTrashState(folder.syntheticTrash, item, folder.revision)) this.trashConflict('Synthetic restore was blocked because the folder revision or current receipt changed.');
    const members = this.receiptMembers(collection, receiptId);
    if (!members.exact) this.trashConflict('Synthetic restore was blocked because a child revision changed after the folder entered Trash.');
    if (this.folderRestoreNamespaceOccupied(collection, members.plan!)) this.trashConflict('Synthetic restore was blocked because the original folder namespace is occupied.');
    if (!members.namespaceExact) this.trashConflict('Synthetic restore was blocked because the folder subtree gained an unrelated item after entering Trash.');
    members.files.forEach(file => { file.deletedAt = undefined; file.syntheticTrash = undefined; file.updatedAt = new Date().toISOString(); file.operationRevision = this.store.nextRevision() });
    members.folders.forEach(candidate => { candidate.deletedAt = undefined; candidate.syntheticTrash = undefined; candidate.revision = this.store.nextRevision() });
    delete this.store.state.folderReceipts[receiptId];
    this.store.persist();
    return { status: 'restored', kind: 'folder', id: folder.folderId, path: folder.path, revision: folder.revision, currentTombstone: null, receiptId };
  }
  async purgeTrashItem(item:FilesTrashItem):Promise<FilesTrashPurgeResult> {
    const collection = this.store.currentCollection();

    if (item.kind === 'file') {
      const file = collection.files.find(candidate => candidate.id === item.id);

      if (!file?.deletedAt || !this.exactTrashState(file.syntheticTrash, item, file.operationRevision ?? '0')) this.trashConflict('Synthetic purge was blocked because the file revision or current tombstone changed.');
      const receiptId = file.syntheticTrash!.tombstone.receiptId ?? null; const recoveryRequired = file.syntheticTrash!.purgeOutcome === 'recovery-required';

      collection.files = collection.files.filter(candidate => candidate.id !== file.id); this.store.persist();
      if (recoveryRequired) return { status: 'recovery-required', metadataPurged: true, chunks: 'pending', retainedArtifacts: 'preserved', undo: 'invalidated', receiptId, reason: 'Synthetic metadata was removed, but the fixture intentionally preserves retained artifacts for recovery.' };
      return { status: 'purged', metadataPurged: true, chunks: 'complete', retainedArtifacts: 'complete', undo: receiptId ? 'invalidated' : 'unavailable', receiptId };
    }
    const folder = collection.folders.find(candidate => candidate.folderId === item.id); const receiptId = folder?.syntheticTrash?.tombstone.receiptId;

    if (!folder?.deletedAt || !receiptId || !this.exactTrashState(folder.syntheticTrash, item, folder.revision)) this.trashConflict('Synthetic purge was blocked because the folder revision or current receipt changed.');
    const members = this.receiptMembers(collection, receiptId);
    if (!members.exact || !members.namespaceExact) this.trashConflict('Synthetic purge was blocked because the folder membership changed after entering Trash.');
    const fileIds = new Set(members.files.map(file => file.id)); const folderIds = new Set(members.folders.map(candidate => candidate.folderId));

    collection.files = collection.files.filter(file => !fileIds.has(file.id)); collection.folders = collection.folders.filter(candidate => !folderIds.has(candidate.folderId)); delete this.store.state.folderReceipts[receiptId]; this.store.persist();
    return { status: 'purged', kind: 'folder', id: folder.folderId, path: folder.path, revision: folder.revision, currentTombstone: null, metadataPurged: true, chunks: 'complete', retainedArtifacts: 'complete', undo: 'invalidated', receiptId };
  }
  async trashFile(fileId:string) { const file = this.store.currentCollection().files.find(item => item.id === fileId && !item.deletedAt); if (!file) throw new Error('Synthetic file is no longer available'); const receiptId = crypto.randomUUID(); file.deletedAt = new Date().toISOString(); file.updatedAt = file.deletedAt; file.operationRevision = this.store.nextRevision(); file.syntheticTrash = { listed: true, revision: file.operationRevision, tombstone: { kind: 'version', id: file.currentVersionId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: this.store.iso(30) } } }; this.store.persist() }
  async purgeTrash(fileId:string) { const collection = this.store.currentCollection(); const file = collection.files.find(item => item.id === fileId && item.deletedAt); if (!file) throw new Error('Synthetic file is not in Trash'); collection.files = collection.files.filter(item => item.id !== fileId); this.store.persist() }
}
