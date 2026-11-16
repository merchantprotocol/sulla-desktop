// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isFilesOperationState } from '../types';
import type { SyntheticFilesStore } from './SyntheticFilesStore';
import type { SyntheticMutationJournal } from './SyntheticMutationJournal';
import { SyntheticValues } from './SyntheticValues';
import type { SyntheticCollection, SyntheticFile, SyntheticFolder, SyntheticOperation } from './SyntheticFilesTypes';
import type { FilesCollisionDestination, FilesOperationItem, FilesOperationItemReceipt } from '../types';

/** Executes one operation item (move, copy, rename, trash, create-folder) against the synthetic store with collision policies. */
export class SyntheticOperationExecutor {
  constructor(private readonly store:SyntheticFilesStore, private readonly journal:SyntheticMutationJournal) {}

  executeItem(operation:SyntheticOperation, item:FilesOperationItem, receipt:FilesOperationItemReceipt) {
    const before = SyntheticValues.clone(this.store.state.collections); const beforeFolderShares = SyntheticValues.clone(this.store.folderShares); const beforeFolderReceipts = SyntheticValues.clone(this.store.state.folderReceipts);
    const beforeRevision = this.store.state.revision; const beforeSequence = this.store.state.sequence; const beforeStaleReplaceAdvanced = this.store.state.staleReplaceAdvanced; const receiptId = crypto.randomUUID();

    try {
      const override = operation.retryOverrides[item.itemId]; const policy = override?.collisionPolicy ?? item.collisionPolicy; const collection = this.store.collection(operation.request.collectionId);

      if (item.action === 'create-folder') this.executeCreateFolder(collection, item, receipt, receiptId, policy);
      else if (item.kind === 'folder' || item.folderPath) this.executeFolder(collection, item, receipt, receiptId, policy, override?.expectedDestination ?? item.expectedDestination);
      else this.executeFile(collection, item, receipt, receiptId, policy, override?.expectedDestination ?? item.expectedDestination);
      if (receipt.state === 'completed') operation.mutations[item.itemId] = this.journal.captureMutation(before, this.store.state.collections, beforeFolderShares, this.store.folderShares);
    } catch (cause) {
      const error = cause as { status?:number; code?:string; message?:string; destination?:FilesCollisionDestination; preserveSyntheticFixture?:boolean };

      if (!error.preserveSyntheticFixture) {
        this.store.state.collections = before; this.store.folderShares = beforeFolderShares; this.store.state.folderReceipts = beforeFolderReceipts;
        this.store.state.revision = beforeRevision; this.store.state.sequence = beforeSequence; this.store.state.staleReplaceAdvanced = beforeStaleReplaceAdvanced;
      }

      Object.assign(receipt, { state: 'failed', receiptId: null, error: { status: error.status ?? 409, code: error.code ?? 'state-conflict', message: error.message ?? String(cause), ...(error.destination ? { destination: error.destination } : {}) }, retryable: true, undoSupported: false });
    }
  }
  private resolveDestination(collection:SyntheticCollection, requested:string, policy:FilesOperationItem['collisionPolicy'], receipt:FilesOperationItemReceipt, ignoredFiles = new Set<string>(), ignoredFolders = new Set<string>(), expected?:FilesCollisionDestination) {
    const file = this.store.activeFileAt(collection, requested, ignoredFiles); const folder = this.store.activeFolderAt(collection, requested, ignoredFolders);

    if (!file && !folder) {
      if (policy === 'replace') throw { status: 409, code: 'destination-conflict', message: 'The synthetic Replace destination no longer exists; refresh Files.', ...(expected ? { destination: SyntheticValues.clone(expected) } : {}) };
      return { path: requested };
    }
    if (policy === 'skip') { Object.assign(receipt, { state: 'skipped', receiptId: crypto.randomUUID(), error: null, retryable: false }); return null }
    if (policy === 'keep-both') return { path: this.store.keepBothPath(collection, requested, ignoredFiles, ignoredFolders) };
    const destination = file ? this.store.fileState(file, collection.id) : undefined;

    if (policy !== 'replace') throw { status: 409, code: 'destination-conflict', message: 'A synthetic item already exists at ' + requested + '.', ...(destination ? { destination } : {}) };
    if (!file || !expected || !this.store.sameFileState(destination, expected)) throw { status: 409, code: 'destination-conflict', message: 'Replace requires the current authorized synthetic destination snapshot.', ...(destination ? { destination } : {}) };
    return { path: requested, displaced: file, displacedBefore: destination };
  }
  private executeFile(source:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy'], expectedDestination?:FilesCollisionDestination) {
    const file = source.files.find(candidate => candidate.id === item.fileId && !candidate.deletedAt);

    if (!file) throw { code: 'state-conflict', message: 'Synthetic source file is no longer available.' };
    const before = this.store.fileState(file, source.id);
    if (before.versionId !== item.expectedVersionId || before.revision !== item.expectedRevision) throw { code: 'state-conflict', message: 'Synthetic source version or revision changed.' };
    receipt.before = SyntheticValues.clone(before); receipt.receiptId = receiptId;
    if (item.action === 'trash') {
      file.deletedAt = new Date().toISOString(); file.updatedAt = file.deletedAt; file.operationRevision = this.store.nextRevision();
      file.syntheticTrash = {
        listed: true, revision: file.operationRevision,
        tombstone: { kind: 'version', id: file.currentVersionId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: this.store.iso(30) } },
      };
      Object.assign(receipt, { after: this.store.fileState(file, source.id), state: 'completed', undoSupported: true, retryable: false });
      return;
    }
    if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic destination path is required.' };
    const targetCollection = this.store.collection(item.targetCollectionId ?? source.id);
    const expectedFileDestination = isFilesOperationState(expectedDestination) ? expectedDestination : undefined;
    const target = this.resolveDestination(targetCollection, this.store.normalizePath(item.targetPath), policy, receipt, new Set<string>(item.action === 'move' ? [file.id] : []), new Set<string>(), expectedFileDestination);
    if (!target) return;
    if (target.displaced) {
      const slash = target.path.lastIndexOf('/'); const parent = slash < 0 ? '' : target.path.slice(0, slash); const name = slash < 0 ? target.path : target.path.slice(slash + 1);

      target.displaced.path = [parent, '.replaced-' + receiptId.slice(0, 8) + '-' + name].filter(Boolean).join('/');
      target.displaced.operationRevision = this.store.nextRevision(); target.displaced.updatedAt = new Date().toISOString();
      receipt.displacedBefore = target.displacedBefore; receipt.displacedAfter = this.store.fileState(target.displaced, targetCollection.id);
    }
    if (item.action === 'copy') {
      const copy = { ...SyntheticValues.clone(file), id: this.store.nextId('synthetic-copy'), path: target.path, currentVersionId: this.store.nextId('version-copy'), operationRevision: this.store.nextRevision(), updatedAt: new Date().toISOString(), deletedAt: undefined };

      targetCollection.files.push(copy); receipt.after = this.store.fileState(copy, targetCollection.id);
    } else {
      if (targetCollection !== source) { source.files = source.files.filter(candidate => candidate.id !== file.id); targetCollection.files.push(file) }
      file.path = target.path; file.operationRevision = this.store.nextRevision(); file.updatedAt = new Date().toISOString(); receipt.after = this.store.fileState(file, targetCollection.id);
    }
    Object.assign(receipt, { state: 'completed', error: null, retryable: false, undoSupported: true });
  }
  private executeCreateFolder(collection:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy']) {
    if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic folder path is required.' };
    if (policy === 'replace') throw { status: 422, code: 'folder-replace-unavailable', message: 'Synthetic folders support Keep Both or Skip, not Replace.' };
    const target = this.resolveDestination(collection, this.store.normalizePath(item.targetPath), policy, receipt);
    if (!target) return;
    const folder = { folderId: this.store.nextId('synthetic-folder'), path: target.path, revision: this.store.nextRevision() };

    collection.folders.push(folder);
    Object.assign(receipt, { receiptId, before: null, after: SyntheticValues.clone(folder), state: 'completed', error: null, undoSupported: true, retryable: false });
  }
  private executeFolder(collection:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy'], expectedDestination?:FilesCollisionDestination) {
    const sourcePath = this.store.normalizePath(item.folderPath ?? ''); let folder = collection.folders.find(candidate => !candidate.deletedAt && candidate.path === sourcePath);
    const sourceState = folder ? this.store.folderState(folder, collection.id) : undefined;
    const files = collection.files.filter(file => !file.deletedAt && file.path.startsWith(sourcePath + '/')); let folders = collection.folders.filter(candidate => !candidate.deletedAt && (candidate.path === sourcePath || candidate.path.startsWith(sourcePath + '/')));

    if (!files.length && !folders.length || item.expectedFolder && !this.store.sameFolderState(sourceState, item.expectedFolder)) throw { code: 'source-conflict', message: 'Synthetic folder identity, collection, or revision changed.' };
    receipt.before = sourceState ? SyntheticValues.clone(sourceState) : null; receipt.receiptId = receiptId;
    const sourceSnapshot = this.store.folderSourceSnapshot(collection, sourcePath);
    const targetCollection = this.store.collection(item.targetCollectionId ?? collection.id); const crossCollection = targetCollection.id !== collection.id;

    if ((crossCollection || item.sourceSubtreeSignature !== undefined) && (!item.sourceSubtreeSignature || !/^[0-9a-f]{64}$/.test(item.sourceSubtreeSignature) || item.sourceSubtreeSignature !== sourceSnapshot.subtreeSignature)) {
      throw { status: 409, code: 'source-conflict', message: 'The synthetic source folder subtree changed; refresh Files.' };
    }
    if (item.action === 'trash') {
      const deletedAt = new Date().toISOString();

      if (!folder) {
        folder = { folderId: this.store.nextId('synthetic-folder-implicit'), path: sourcePath, revision: this.store.nextRevision() };
        collection.folders.push(folder); folders = [folder, ...folders];
      }
      const rootFolder = folder;

      files.forEach(file => {
        const childReceiptId = this.store.nextId('synthetic-trash-child-receipt');

        file.deletedAt = deletedAt; file.operationRevision = this.store.nextRevision(); file.updatedAt = deletedAt;
        file.syntheticTrash = { listed: true, revision: file.operationRevision, parentReceiptId: receiptId, tombstone: { kind: 'version', id: file.currentVersionId, receiptId: childReceiptId, operationId: childReceiptId, undo: { state: 'available', expiresAt: this.store.iso(30) } } };
      });
      folders.forEach(candidate => {
        candidate.deletedAt = deletedAt; candidate.revision = this.store.nextRevision();
        candidate.syntheticTrash = { listed: candidate.folderId === rootFolder.folderId, revision: candidate.revision, parentReceiptId: receiptId, tombstone: { kind: 'receipt', id: receiptId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: this.store.iso(30) } } };
      });
      this.store.state.folderReceipts[receiptId] = {
        collectionId: collection.id, rootFolderId: rootFolder.folderId, rootPath: sourcePath,
        files: files.map(file => ({ id: file.id, path: file.path, revision: file.operationRevision ?? '0', receiptId: file.syntheticTrash!.tombstone.receiptId! })),
        folders: folders.map(candidate => ({ id: candidate.folderId, path: candidate.path, revision: candidate.revision })),
      };
      receipt.after = null;
    } else {
      if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic folder destination is required.' };
      const requestedTarget = this.store.normalizePath(item.targetPath);

      if (!crossCollection && (requestedTarget === sourcePath || requestedTarget.startsWith(sourcePath + '/') || sourcePath.startsWith(requestedTarget + '/'))) throw { status: 409, code: 'invalid-operation', message: 'A synthetic folder destination cannot overlap its source.' };
      const ignoredFiles = new Set(files.map(file => file.id)); const ignoredFolders = new Set(folders.map(value => value.folderId));
      const moveIgnoredFiles = item.action === 'move' && !crossCollection ? ignoredFiles : new Set<string>(); const moveIgnoredFolders = item.action === 'move' && !crossCollection ? ignoredFolders : new Set<string>();
      const destinationFile = this.store.activeFileAt(targetCollection, requestedTarget, moveIgnoredFiles); const destinationFolder = this.store.activeFolderAt(targetCollection, requestedTarget, moveIgnoredFolders);
      let targetPath = requestedTarget;
      let displacedFiles:SyntheticFile[] = []; let displacedFolders:SyntheticFolder[] = []; let recovery:string | undefined;

      if (policy === 'replace' && !destinationFile && !destinationFolder) {
        throw { status: 409, code: 'destination-conflict', message: 'The synthetic Replace destination no longer exists; refresh Files.', ...(expectedDestination ? { destination: SyntheticValues.clone(expectedDestination) } : {}) };
      }

      if (destinationFile || destinationFolder) {
        if (policy === 'skip') { Object.assign(receipt, { state: 'skipped', error: null, retryable: false, undoSupported: false }); return }
        if (policy === 'keep-both') targetPath = this.store.keepBothPath(targetCollection, requestedTarget, moveIgnoredFiles, moveIgnoredFolders);
        else {
          const displayed = destinationFolder ? this.store.folderReplacementDestination(targetCollection, requestedTarget) : undefined;

          if (policy !== 'replace') {
            // This fixture advances only a descendant revision after exposing the
            // snapshot. The unchanged root revision makes the retry depend on the
            // subtree signature, matching the service's stale-tree CAS contract.
            if (destinationFolder?.folderId === 'synthetic-folder-stale-destination' && displayed && !this.store.state.staleReplaceAdvanced) {
              const child = targetCollection.files.find(file => file.id === 'synthetic-stale-destination-file');

              this.store.state.staleReplaceAdvanced = true;
              if (child) { child.operationRevision = this.store.nextRevision(); child.updatedAt = new Date().toISOString() }
            }
            throw { status: 409, code: 'destination-conflict', message: 'A synthetic folder already exists at ' + requestedTarget + '. Choose Replace, Keep Both or Skip.', ...(displayed ? { destination: displayed } : {}), preserveSyntheticFixture: destinationFolder?.folderId === 'synthetic-folder-stale-destination' };
          }
          if (!displayed || !this.store.sameFolderReplacementDestination(displayed, expectedDestination)) {
            throw { status: 409, code: 'destination-conflict', message: 'The synthetic Replace destination subtree changed; refresh Files.', ...(displayed ? { destination: displayed } : expectedDestination ? { destination: SyntheticValues.clone(expectedDestination) } : {}) };
          }
          displacedFiles = targetCollection.files.filter(file => !file.deletedAt && file.path.startsWith(requestedTarget + '/'));
          displacedFolders = targetCollection.folders.filter(candidate => !candidate.deletedAt && (candidate.path === requestedTarget || candidate.path.startsWith(requestedTarget + '/')));
          const slash = requestedTarget.lastIndexOf('/'); const parent = slash < 0 ? '' : requestedTarget.slice(0, slash); const name = slash < 0 ? requestedTarget : requestedTarget.slice(slash + 1);
          recovery = [parent, '.replaced-' + receiptId + '-' + name].filter(Boolean).join('/');

          if (this.store.activeFileAt(targetCollection, recovery) || this.store.activeFolderAt(targetCollection, recovery) || targetCollection.files.some(file => !file.deletedAt && file.path.startsWith(recovery + '/')) || targetCollection.folders.some(candidate => !candidate.deletedAt && candidate.path.startsWith(recovery + '/'))) {
            throw { status: 409, code: 'state-conflict', message: 'Synthetic Replace recovery sibling is occupied.' };
          }
        }
      }
      const mappedFiles = files.map(file => ({ file, path: targetPath + file.path.slice(sourcePath.length) })); const mappedFolders = folders.map(value => ({ folder: value, path: targetPath + value.path.slice(sourcePath.length) }));
      const sourceFolderShares = this.store.folderShares.filter(share => share.collectionId === collection.id && (share.folderPath === sourcePath || share.folderPath.startsWith(sourcePath + '/')));
      const preflightFiles = new Set([...ignoredFiles, ...displacedFiles.map(file => file.id)]); const preflightFolders = new Set([...ignoredFolders, ...displacedFolders.map(candidate => candidate.folderId)]);
      const conflict = mappedFiles.find(value => this.store.activeFileAt(targetCollection, value.path, preflightFiles) || this.store.activeFolderAt(targetCollection, value.path, preflightFolders)) ?? mappedFolders.find(value => this.store.activeFileAt(targetCollection, value.path, preflightFiles) || this.store.activeFolderAt(targetCollection, value.path, preflightFolders));

      if (conflict) throw { code: 'destination-conflict', message: 'A synthetic descendant already exists at ' + conflict.path + '.' };
      if (destinationFolder && recovery) {
        const recoveryPath = recovery;

        receipt.displacedBefore = this.store.folderState(destinationFolder, targetCollection.id);
        displacedFolders.forEach(candidate => { candidate.path = recoveryPath + candidate.path.slice(requestedTarget.length); candidate.revision = this.store.nextRevision() });
        displacedFiles.forEach(file => { file.path = recoveryPath + file.path.slice(requestedTarget.length); file.operationRevision = this.store.nextRevision(); file.updatedAt = new Date().toISOString() });
        this.store.folderShares.filter(share => share.collectionId === targetCollection.id && (share.folderPath === requestedTarget || share.folderPath.startsWith(requestedTarget + '/')))
          .forEach(share => { share.folderPath = recoveryPath + share.folderPath.slice(requestedTarget.length) });

        receipt.displacedAfter = this.store.folderState(destinationFolder, targetCollection.id);
      }
      if (item.action === 'copy') {
        mappedFolders.forEach(value => targetCollection.folders.push({ folderId: this.store.nextId('synthetic-folder-copy'), path: value.path, revision: this.store.nextRevision() }));
        mappedFiles.forEach(value => targetCollection.files.push({ ...SyntheticValues.clone(value.file), id: this.store.nextId('synthetic-copy'), path: value.path, currentVersionId: this.store.nextId('version-copy'), operationRevision: this.store.nextRevision(), updatedAt: new Date().toISOString() }));
        sourceFolderShares.forEach(share => this.store.folderShares.push({ ...SyntheticValues.clone(share), id: this.store.nextId('synthetic-folder-share-copy'), collectionId: targetCollection.id, folderPath: targetPath + share.folderPath.slice(sourcePath.length) }));
        const copied = targetCollection.folders.find(value => value.path === targetPath) ?? { folderId: this.store.nextId('synthetic-folder-copy'), path: targetPath, revision: this.store.nextRevision() };

        if (!targetCollection.folders.includes(copied)) targetCollection.folders.push(copied);
        receipt.after = this.store.folderState(copied, targetCollection.id);
      } else {
        if (crossCollection) {
          collection.folders = collection.folders.filter(candidate => !ignoredFolders.has(candidate.folderId));
          collection.files = collection.files.filter(candidate => !ignoredFiles.has(candidate.id));
          targetCollection.folders.push(...folders); targetCollection.files.push(...files);
        }
        mappedFolders.forEach(value => { value.folder.path = value.path; value.folder.revision = this.store.nextRevision() });
        mappedFiles.forEach(value => { value.file.path = value.path; value.file.operationRevision = this.store.nextRevision(); value.file.updatedAt = new Date().toISOString() });
        sourceFolderShares.forEach(share => { share.collectionId = targetCollection.id; share.folderPath = targetPath + share.folderPath.slice(sourcePath.length) });
        const moved = folder ?? { folderId: this.store.nextId('synthetic-folder-move'), path: targetPath, revision: this.store.nextRevision() };

        if (!folder) targetCollection.folders.push(moved);
        receipt.after = this.store.folderState(moved, targetCollection.id);
      }
    }
    Object.assign(receipt, { state: 'completed', error: null, undoSupported: true, retryable: false });
  }
}
