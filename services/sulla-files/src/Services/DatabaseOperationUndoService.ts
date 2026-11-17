// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import { CloudRenameSuccessor } from '../Repositories/CloudRenameSuccessor.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import { OperationRecords, type DatabaseOperationAccess, type DatabaseOperationReceipt, type DatabaseOperationState,
  type OperationGuard, type UndoAuthority } from './DatabaseOperationTypes.js';
import { OperationFailure } from './OperationFailure.js';

const fail = OperationFailure.of;

/** Undoes one file or create-folder receipt, and creates stored folders with a receipt. */
export class DatabaseOperationUndoService {
  constructor(private readonly context:DatabaseOperationContext) {}

  async undo(operationId:string, actor:FilesIdentity, access:DatabaseOperationAccess, guard?:OperationGuard, existingClient?:pg.PoolClient, internal?:UndoAuthority):Promise<DatabaseOperationReceipt> {
    if (!OperationFailure.uuid.test(operationId)) throw fail(400, 'operationId must be a UUID');
    const scope = OperationFailure.scope(actor);
    const collection = await this.context.receipts.ownedHeader(existingClient ?? this.context.db, operationId, actor.userId, scope);
    if (collection && !existingClient) await access.prepare?.(collection.collection_id);
    if (collection?.request.targetCollectionId && !existingClient) await access.prepare?.(collection.request.targetCollectionId);
    const execute = (client:pg.PoolClient) => this.run(client, operationId, actor, access, guard, internal);
    return existingClient ? execute(existingClient) : this.context.transaction.run(execute);
  }

  private async run(client:pg.PoolClient, operationId:string, actor:FilesIdentity, access:DatabaseOperationAccess, guard?:OperationGuard, internal?:UndoAuthority):Promise<DatabaseOperationReceipt> {
    const { files, receipts, locks, policy, audit, versions } = this.context;
    if (guard) await guard(client);
    const row = await receipts.lockOwned(client, operationId, actor.userId, OperationFailure.scope(actor));
    if (!row) throw fail(404, 'Database operation receipt not found; native undo is unsupported');
    if (row.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt) throw fail(409,'Undo was explicitly invalidated by permanent disposal');
    if (row.request.targetCollectionId && row.request.targetCollectionId!==row.collection_id) {
      await policy.crossCollectionBoundary(client,row.collection_id,row.request.targetCollectionId,actor,
        {sourcePath:row.before_state?.path,targetPath:row.after_state?.path,fileIds:[row.before_state?.fileId].filter(Boolean)});
    }
    for (const id of [...new Set([row.collection_id,row.request.targetCollectionId].filter(Boolean))].sort()) await locks.lockNamespace(client, id);
    if (!internal?.permissionSignatureVerified && row.state === 'completed' && row.permission_signature && row.permission_signature !== await policy.permissionSignature(client,row.collection_id,row.id)) throw fail(409, 'Permissions or public links changed after the operation');
    if (row.action === 'create-folder') return this.undoCreateFolder(client, row, operationId, actor, access);
    const file = await policy.lockedFile(client, row.after_state.fileId, access);
    if (row.state === 'undone') return OperationRecords.receipt(row);
    if (row.state !== 'completed') throw fail(409, 'Skipped operations cannot be undone');
    const expected = row.after_state as DatabaseOperationState; const before = row.before_state as DatabaseOperationState;
    if (JSON.stringify(OperationRecords.snapshot(file)) !== JSON.stringify(OperationRecords.expected(expected, row.collection_id))) throw fail(409, 'Undo refused because the file changed after the operation');
    policy.editable(file, actor);
    await access.path(client, before.collectionId??row.collection_id, before.path);
    if (!internal?.folderGrantMigration && file.collection_id===(before.collectionId??row.collection_id)) await policy.permissionBoundary(client, file.collection_id, file.path, before.path);
    if (row.action !== 'copy' && await files.undoDestinationOccupied(client, before.collectionId??row.collection_id, before.path, file.id)) throw fail(409, 'Undo destination is occupied');
    let updated:any;
    if (row.action === 'copy') {
      const version = await versions.insertUndoCopyTombstone(client, file, actor);
      const recoveryPath = file.path + '.undone-' + row.id;
      await access.path(client, file.collection_id, recoveryPath);
      await policy.permissionBoundary(client, file.collection_id, file.path, recoveryPath);
      updated = await files.retireCopy(client, file.id, recoveryPath, version.id);
    } else if (row.action === 'trash') {
      const source = await versions.lockTrashParentId(client, before.versionId, expected.versionId, file.id);
      if (!source) throw fail(409, 'Undo source version is no longer available');
      // Trash did not change publication pointers/statuses; restore that exact
      // parent while retaining the tombstone and all history.
      updated = await files.untrash(client, file.id, before.versionId);
    } else updated = await files.relocate(client, file.id, before.path, before.collectionId??row.collection_id);
    if (row.action !== 'copy' && row.action !== 'trash' && !internal?.parentFollows) {
      const successor = new CloudRenameSuccessor(actor);
      await successor.versionFor(client, { fileId:file.id, currentVersionId:file.current_version_id, parentFollows:false });
      if (successor.updatedFile) updated = successor.updatedFile;
    }
    if (row.displaced_before) await this.restoreDisplaced(client, row, actor, access, internal);
    await audit.recordFileOperation(client, actor, updated, row.action === 'trash' ? 'restore' : row.action === 'copy' ? 'delete' : 'rename', row.id);
    await access.custody?.publish(client,row,true);
    return OperationRecords.receipt(await receipts.markUndone(client, row.id));
  }

  private async restoreDisplaced(client:pg.PoolClient, row:any, actor:FilesIdentity, access:DatabaseOperationAccess, internal?:UndoAuthority):Promise<void> {
    const { files, policy } = this.context;
    const displaced = await policy.lockedFile(client, row.displaced_after.fileId, access);
    const expectedDisplaced = row.displaced_after;
    if (displaced.path !== expectedDisplaced.path || displaced.current_version_id !== expectedDisplaced.versionId || String(displaced.operation_revision) !== expectedDisplaced.revision || Boolean(displaced.deleted_at) !== expectedDisplaced.deleted) throw fail(409, 'The displaced file changed; undo refused');
    policy.editable(displaced, actor);
    await access.path(client, displaced.collection_id, row.displaced_before.path);
    if (!internal?.folderGrantMigration) await policy.permissionBoundary(client, displaced.collection_id, displaced.path, row.displaced_before.path);
    const restored = await files.rename(client, displaced.id, row.displaced_before.path);
    const successor = new CloudRenameSuccessor(actor);
    await successor.versionFor(client, { fileId:displaced.id, currentVersionId:displaced.current_version_id, parentFollows:false });
    await this.context.audit.recordFileOperation(client, actor, successor.updatedFile ?? restored, 'rename', row.id);
  }

  private async undoCreateFolder(client:pg.PoolClient, row:any, operationId:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseOperationReceipt> {
    const { subtree, receipts, locks } = this.context;
    await access.path(client, row.collection_id, row.after_state?.path ?? row.request.targetPath);
    if (row.state === 'undone') return OperationRecords.receipt(row);
    if (row.state !== 'completed') throw fail(409, 'Skipped folders cannot be undone');
    await locks.lockNamespace(client, row.collection_id);
    const folder = await subtree.lockFolder(client, row.after_state.folderId);
    if (!folder || folder.path !== row.after_state.path || String(folder.operation_revision) !== row.after_state.revision) throw fail(409, 'Folder changed after creation');
    if (await subtree.createdFolderInUse(client, row.collection_id, folder.path)) throw fail(409, 'Folder acquired children or grants; undo refused');
    await subtree.deleteFolder(client, folder.id);
    await access.custody?.publish(client,row,true);
    await this.context.audit.undoCreateFolder(client, actor, { operationId, collectionId: row.collection_id, path: folder.path });
    return OperationRecords.receipt(await receipts.markUndone(client, row.id));
  }

  async createFolder(input:{ idempotencyKey:string; collectionId:string; targetPath:string; collisionPolicy?:'keep-both'|'skip' }, actor:FilesIdentity, access:DatabaseOperationAccess, guard:OperationGuard):Promise<DatabaseOperationReceipt> {
    const { files, receipts, locks, subtree, audit } = this.context;
    const scope = OperationFailure.scope(actor);
    await access.prepare?.(input.collectionId);
    return this.context.transaction.run(async client => {
      await guard(client);
      await locks.lockNamespace(client, input.collectionId);
      await access.path(client, input.collectionId, input.targetPath);
      const prior = await receipts.findPrior(client, actor.userId, scope, input.idempotencyKey);
      if (prior) return OperationRecords.receipt(prior);
      if (!access.custody && await files.hasNativeRoot(client, input.collectionId)) throw Object.assign(fail(422, 'Native folders require custody'), { code:'native-custody-required' });
      const occupied = async(path:string) => await files.namespaceOccupied(client, input.collectionId, path) || Boolean(await access.custody?.occupied(input.collectionId,path));
      let path = input.targetPath; let skipped = false;
      if (await occupied(path)) {
        if (input.collisionPolicy === 'skip') skipped = true;
        else if (input.collisionPolicy === 'keep-both') {
          let n = 2;
          while (await occupied(path) && n <= 1000) path = input.targetPath + ' (' + n++ + ')';
          if (await occupied(path)) throw fail(409, 'No Keep Both folder destination available');
        } else throw Object.assign(fail(409, 'Folder destination exists'), { code: 'destination-conflict' });
      }
      await access.path(client, input.collectionId, path);
      let after:any = null;
      if (!skipped) {
        const folder = await subtree.insertFolder(client, input.collectionId, path, actor.userId);
        after = { folderId: folder.id, path, revision: String(folder.operation_revision) };
      }
      const row = await receipts.insertCreateFolder(client, actor.userId, scope, input.idempotencyKey, input, input.collectionId, skipped ? 'skipped' : 'completed', JSON.stringify(after));
      await audit.createFolder(client, actor, { operationId: row.id, collectionId: input.collectionId, path, skipped });
      if (!skipped) await access.custody?.publish(client,row,false);
      return OperationRecords.receipt(row);
    });
  }
}
