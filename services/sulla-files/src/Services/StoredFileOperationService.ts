// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import { CloudRenameSuccessor } from '../Repositories/CloudRenameSuccessor.js';
import { StoredFileOperationRepository } from '../Repositories/StoredFileOperationRepository.js';
import { assertStoredFilePath, assertStoredFolderPath, ensureStoredFileParents, ensureStoredFolder, lockStoredNamespace } from '../storedNamespace.js';

export class FileOperationConflict extends Error { status = 409 }

export interface StoredFolderMove { collectionId:string; sourcePath:string; targetPath:string }

/** Copies a locked file row (current or `copy_version_id` version) to a new path inside the caller's transaction. */
export class StoredFileCopier {
  constructor(private readonly rows = new StoredFileOperationRepository()) {}

  async copy(client:pg.PoolClient, source:any, targetPath:string, actor:FilesIdentity):Promise<any> {
    const version = await this.rows.copySource(client, source.copy_version_id ?? source.current_version_id);
    if (!version) throw Object.assign(new Error('The current version is not copyable'), { status: 409 });
    const inserted = await this.rows.insertCopy(client, source, targetPath, actor);
    const copiedVersion = await this.rows.insertCopyVersion(client, inserted.id, version, actor, source.path);
    await this.rows.finishCopy(client, source.collection_id, inserted.id, copiedVersion.id, version);
    return { ...inserted, current_version_id: copiedVersion.id };
  }
}

/** Legacy (receipt-less) move/copy of stored Files items inside one collection, in one transaction. */
export class StoredFileOperationService {
  constructor(
    private readonly transactions:Pick<TransactionRunner, 'run'>,
    private readonly rows = new StoredFileOperationRepository(),
    private readonly copier = new StoredFileCopier(rows),
  ) {}

  async apply(action:'move' | 'copy', sources:{ file:any; targetPath:string }[], actor:FilesIdentity, folderMoves:StoredFolderMove[] = []):Promise<any[]> {
    if (new Set(sources.map(source => source.targetPath)).size !== sources.length) throw new FileOperationConflict('Two selected items have the same destination');
    return this.transactions.run('stored-file-operations', client => this.applyLocked(client, action, sources, actor, folderMoves));
  }

  private async applyLocked(client:pg.PoolClient, action:'move' | 'copy', sources:{ file:any; targetPath:string }[], actor:FilesIdentity, folderMoves:StoredFolderMove[]):Promise<any[]> {
    const collectionId = sources[0]?.file.collection_id ?? folderMoves[0]?.collectionId;
    if (!collectionId) throw Object.assign(new Error('No stored Files items were selected'), { status: 404 });
    if (sources.some(source => source.file.collection_id !== collectionId) || folderMoves.some(folder => folder.collectionId !== collectionId)) {
      throw Object.assign(new Error('Stored Files operations must stay within one collection'), { status: 400 });
    }
    await lockStoredNamespace(client, collectionId);
    const locked:any[] = [];
    for (const source of sources) {
      const row = await this.rows.lockLive(client, source.file.id);
      if (!row) throw Object.assign(new Error('A selected file is no longer available'), { status: 404 });
      if (row.collection_id !== source.file.collection_id || row.path !== source.file.path || row.current_version_id !== source.file.current_version_id) throw new FileOperationConflict('A selected file changed while the operation was starting. Refresh Files and try again.');
      locked.push({ file: { ...row, copy_version_id: source.file.copy_version_id }, targetPath: source.targetPath });
    }
    const storedFolders:StoredFolderMove[] = [];
    for (const folder of folderMoves) {
      const rows = await this.rows.lockFolderPaths(client, folder.collectionId, folder.sourcePath);
      if (!rows.rowCount && !sources.some(source => source.file.path.startsWith(`${ folder.sourcePath }/`))) throw Object.assign(new Error('A selected folder is no longer available'), { status: 404 });
      if (!rows.rows.some(row => row.path === folder.sourcePath)) rows.rows.unshift({ path: folder.sourcePath });
      for (const row of rows.rows) storedFolders.push({ collectionId: folder.collectionId, sourcePath: row.path, targetPath: `${ folder.targetPath }${ row.path.slice(folder.sourcePath.length) }` });
    }
    const targets = [...locked.map(item => item.targetPath), ...storedFolders.map(folder => folder.targetPath)];
    if (new Set(targets).size !== targets.length) throw new FileOperationConflict('Two selected items have the same destination');
    for (const item of locked) await assertStoredFilePath(client, collectionId, item.targetPath);
    for (const folder of storedFolders) {
      await assertStoredFolderPath(client, collectionId, folder.targetPath);
      if (await this.rows.folderExists(client, collectionId, folder.targetPath)) throw new FileOperationConflict(`A folder already exists at ${ folder.targetPath }`);
    }
    const results:any[] = [];
    for (const item of locked) {
      let result:any;
      if (action === 'copy') result = await this.copier.copy(client, item.file, item.targetPath, actor);
      else {
        result = await this.rows.move(client, item.file.id, item.targetPath);
        // A move that only follows its moved folder keeps its name and parent folder identity in Cloud.
        const parentFollows = folderMoves.some(folder => item.file.path.startsWith(`${ folder.sourcePath }/`)
          && item.targetPath === `${ folder.targetPath }${ item.file.path.slice(folder.sourcePath.length) }`);
        const successor = new CloudRenameSuccessor(actor);
        const versionId = await successor.versionFor(client, { fileId: item.file.id, currentVersionId: item.file.current_version_id, parentFollows });
        result = successor.updatedFile ?? result;
        await this.rows.journalRename(client, item.file.collection_id, item.file.id, versionId);
      }
      results.push(result);
      await this.rows.audit(client, actor, result, action, JSON.stringify({ collectionId: item.file.collection_id, from: item.file.path, to: item.targetPath }));
    }
    if (action === 'copy') {
      for (const folder of storedFolders) await ensureStoredFolder(client, folder.collectionId, folder.targetPath, actor);
    } else {
      for (const folder of [...storedFolders].sort((left, right) => right.sourcePath.length - left.sourcePath.length)) {
        await this.rows.renameFolder(client, folder.collectionId, folder.sourcePath, folder.targetPath);
      }
      for (const folder of folderMoves) await this.rows.moveFolderReferences(client, folder.collectionId, folder.sourcePath, folder.targetPath);
      for (const folder of storedFolders) await ensureStoredFolder(client, folder.collectionId, folder.targetPath, actor);
    }
    for (const item of locked) await ensureStoredFileParents(client, collectionId, item.targetPath, actor);
    return results;
  }
}
