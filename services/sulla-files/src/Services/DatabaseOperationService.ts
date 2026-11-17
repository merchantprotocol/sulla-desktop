// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import { CloudRenameSuccessor } from '../Repositories/CloudRenameSuccessor.js';
import { isProtectedPath, protectedPathError } from '../protectedFiles.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import { folderGrantMigration, OperationRecords, type DatabaseOperationAccess, type DatabaseOperationReceipt,
  type InternalDatabaseOperationRequest, type OperationGuard } from './DatabaseOperationTypes.js';
import { OperationFailure } from './OperationFailure.js';

const fail = OperationFailure.of;
const snapshot = OperationRecords.snapshot;

/** Executes one receipt-backed file move, copy, rename or Trash. */
export class DatabaseOperationService {
  constructor(private readonly context:DatabaseOperationContext) {}

  /**
   * Runs in its own SERIALIZABLE transaction, or inside `existingClient` when a folder
   * operation executes its children within the folder's transaction.
   */
  async execute(input:InternalDatabaseOperationRequest, actor:FilesIdentity, access:DatabaseOperationAccess, guard?:OperationGuard, existingClient?:pg.PoolClient):Promise<DatabaseOperationReceipt> {
    const persistedRequest = { ...input }; delete persistedRequest[folderGrantMigration]; delete persistedRequest.parentFollows;
    if (!existingClient) await access.prepare?.(input.collectionId);
    const destinationCollection = input.targetCollectionId??input.collectionId;
    if (!existingClient && destinationCollection!==input.collectionId) await access.prepare?.(destinationCollection);
    const execute = (client:pg.PoolClient) => this.run(client, input, persistedRequest, destinationCollection, actor, access, guard);
    return existingClient ? execute(existingClient) : this.context.transaction.run(execute);
  }

  private async run(client:pg.PoolClient, input:InternalDatabaseOperationRequest, persistedRequest:object, destinationCollection:string, actor:FilesIdentity, access:DatabaseOperationAccess, guard?:OperationGuard):Promise<DatabaseOperationReceipt> {
    const { files, receipts, locks, policy, audit } = this.context;
    const scope = OperationFailure.scope(actor);
    if (guard) await guard(client);
    for (const id of [...new Set([input.collectionId,destinationCollection])].sort()) await locks.lockNamespace(client, id);
    if (destinationCollection!==input.collectionId) await policy.crossCollectionBoundary(client,input.collectionId,destinationCollection,actor,
      {sourcePath:await files.pathOf(client, input.fileId),targetPath:input.targetPath,fileIds:[input.fileId]});
    await locks.lockNamespace(client, input.collectionId);
    await locks.lock(client, JSON.stringify([actor.userId, scope, input.idempotencyKey]));
    const prior = await receipts.lockPrior(client, actor.userId, scope, input.idempotencyKey, JSON.stringify(input));
    if (prior) {
      if (!prior.same_request) throw fail(409, 'The idempotency key was already used for a different request');
      await policy.lockedFile(client, prior.file_id, access);
      return OperationRecords.receipt(prior);
    }
    const file = await policy.lockedFile(client, input.fileId, access);
    if (file.collection_id !== input.collectionId || file.current_version_id !== input.expectedVersionId ||
      String(file.operation_revision) !== input.expectedRevision || file.deleted_at) throw Object.assign(fail(409, 'The selected file changed; refresh Files'),{code:'source-conflict'});
    policy.editable(file, actor);
    if (await files.hasDescendant(client, file.collection_id, file.path)) throw fail(422, 'Folder-like entries require a folder custody operation');
    const before = snapshot(file);
    let updated = file; let skipped = false;
    // Reserve receipt identity within the same transaction; rollback removes it.
    const row = await receipts.reserveFile(client, actor.userId, scope, input.idempotencyKey, persistedRequest, file.collection_id, file.id, input.action, before);
    if (input.action === 'trash') {
      const version = await this.context.versions.insertTrashTombstone(client, file, actor);
      updated = await files.markTrashed(client, file.id, version.id);
    } else {
      const placed = await this.place(client, input, file, row, destinationCollection, actor, access);
      skipped = placed.skipped;
      if (placed.updated) updated = placed.updated;
      // Receipt-backed moves are the primary Files-mount route. If Cloud already
      // has this version, journaling its id again is ignored by the uploader; make
      // a same-content successor so Cloud observes the new path/parent identity.
      // Folder children only follow their moved Cloud folder, so retain their version.
      if (!skipped && (input.action === 'rename' || input.action === 'move')) {
        const successor = new CloudRenameSuccessor(actor);
        const versionId = await successor.versionFor(client, {
          fileId: file.id,
          currentVersionId: file.current_version_id,
          parentFollows: input.parentFollows === true,
        });
        if (successor.updatedFile) updated = successor.updatedFile;
        else if (versionId !== file.current_version_id) updated = { ...updated, current_version_id: versionId };
      }
    }
    if (!skipped) await audit.recordFileOperation(client, actor, updated, input.action === 'trash' ? 'delete' : input.action === 'copy' ? 'put' : 'rename', row.id);
    const receiptPlan = input.action==='trash' && !skipped
      ? { lifecycle:await policy.receiptLifecycle(client,file.collection_id,new Date(updated.deleted_at)) }
      : null;
    await receipts.complete(client, row.id, snapshot(updated), skipped ? 'skipped' : 'completed', receiptPlan);
    const committed = await receipts.sign(client, row.id, await policy.permissionSignature(client,input.collectionId,row.id));
    if (!skipped) await access.custody?.publish(client,committed,false);
    return OperationRecords.receipt(committed);
  }

  /** Resolves the destination (Replace, Keep Both, Skip or conflict) and moves or copies the file there. */
  private async place(client:pg.PoolClient, input:InternalDatabaseOperationRequest, file:any, row:any, destinationCollection:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<{ skipped:boolean; updated?:any }> {
    const { files, policy } = this.context;
    let target = input.targetPath!;
    if (isProtectedPath(target)) throw protectedPathError();
    if (target === file.path && input.action !== 'copy' && destinationCollection===input.collectionId) throw fail(400, 'Destination must differ from source');
    await access.path(client, destinationCollection, target);
    if (!input[folderGrantMigration] && destinationCollection===file.collection_id) await policy.permissionBoundary(client, file.collection_id, file.path, target);
    if (await files.ancestorIsFile(client, destinationCollection, target)) throw fail(409, 'A file occupies an ancestor of the destination');
    const occupied = async(path:string) => await files.namespaceOccupied(client, destinationCollection, path) || Boolean(await access.custody?.occupied(destinationCollection,path));
    let replaceDestination:any;
    if (input.collisionPolicy === 'replace') replaceDestination = await this.lockReplaceDestination(client, input, file, destinationCollection, target, actor, access);
    if (await occupied(target)) {
      if (input.collisionPolicy === 'replace') {
        if (await this.context.subtree.folderAtOrUnder(client, destinationCollection, target)) throw Object.assign(fail(409,'A folder occupies the destination; choose Keep Both or Skip'), { code:'destination-conflict' });
        await this.displace(client, replaceDestination, target, row, destinationCollection, actor, access, occupied);
      } else if (input.collisionPolicy === 'skip') return { skipped: true };
      else if (input.collisionPolicy === 'keep-both') {
        const dot = target.lastIndexOf('.'); const slash = target.lastIndexOf('/');
        const split = dot > slash + 1 ? dot : target.length;
        let found = false;
        for (let n = 2; n <= 1000; n++) {
          const candidate = target.slice(0, split) + ' (' + n + ')' + target.slice(split);
          if (!await occupied(candidate)) { target = candidate; found = true; break }
        }
        if (!found) throw fail(409, 'No Keep Both destination is available');
      } else {
        const destination = await files.findAtPath(client, destinationCollection, target);
        if (destination) await access.file(client, destination.id);
        throw Object.assign(fail(409, 'Destination already exists; choose Replace, Keep Both or Skip'), { code: 'destination-conflict', ...(destination ? { destination: snapshot(destination) } : {}) });
      }
    }
    await access.path(client, destinationCollection, target);
    if (!input[folderGrantMigration] && destinationCollection===file.collection_id) await policy.permissionBoundary(client, file.collection_id, file.path, target);
    if (await files.ancestorIsFile(client, destinationCollection, target)) throw fail(409, 'A file occupies an ancestor of the destination');
    if (input.action === 'copy') return { skipped: false, updated: await this.copyReceiptFile(client, file, target, actor, destinationCollection) };
    return { skipped: false, updated: await files.relocate(client, file.id, target, destinationCollection) };
  }

  /** Locks the displayed Replace destination and proves it is still exactly what the caller saw. */
  private async lockReplaceDestination(client:pg.PoolClient, input:InternalDatabaseOperationRequest, file:any, destinationCollection:string, target:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<any> {
    const { files, policy } = this.context;
    const destination = await files.lockAtPath(client, destinationCollection, target);
    if (!destination || destination.deleted_at) throw Object.assign(fail(409, 'The Replace destination changed'),{code:'destination-conflict'});
    if (destination.id === file.id) throw Object.assign(fail(409, 'Cannot Replace the source itself; choose Keep Both or Skip'),{code:'destination-conflict',destination:snapshot(destination)});
    const replaceDestination = await policy.lockedFile(client,destination.id,access);
    policy.editable(replaceDestination, actor);
    const expected = input.expectedDestination!;
    if (replaceDestination.id!==expected.fileId || replaceDestination.collection_id!==(expected.collectionId??destinationCollection) ||
      replaceDestination.current_version_id!==expected.versionId || String(replaceDestination.operation_revision)!==expected.revision ||
      replaceDestination.path!==expected.path || replaceDestination.deleted_at) {
      throw Object.assign(fail(409, 'The Replace destination changed'),{code:'destination-conflict',destination:snapshot(replaceDestination)});
    }
    return replaceDestination;
  }

  /** Replace: the destination moves to a same-parent recovery sibling recorded on the receipt. */
  private async displace(client:pg.PoolClient, destination:any, target:string, row:any, destinationCollection:string, actor:FilesIdentity, access:DatabaseOperationAccess, occupied:(path:string)=>Promise<boolean>):Promise<void> {
    const slash = target.lastIndexOf('/');
    const recoveryPath = target.slice(0, slash + 1) + '.replaced-' + row.id + '-' + target.slice(slash + 1);
    if (await occupied(recoveryPath)) throw fail(409,'Replace recovery path is occupied');
    await access.path(client, destinationCollection, recoveryPath);
    await this.context.policy.permissionBoundary(client, destinationCollection, target, recoveryPath);
    const displaced = await this.context.files.rename(client, destination.id, recoveryPath);
    await this.context.audit.recordFileOperation(client, actor, displaced, 'rename', row.id);
    await this.context.receipts.setDisplaced(client, row.id, snapshot(destination), snapshot(displaced));
  }

  /** Copies the file row, its published and current versions, key contexts and direct grants. */
  private async copyReceiptFile(client:pg.PoolClient, source:any, target:string, actor:FilesIdentity, destinationCollection = source.collection_id):Promise<any> {
    const { versions } = this.context;
    const copied = await versions.insertCopiedFile(client, source, target, actor, destinationCollection);
    const ids = [...new Set([source.published_version_id, source.current_version_id].filter(Boolean))];
    let current:string | undefined;
    for (const id of ids) {
      const version = await versions.lockCopySource(client, id, source.id);
      if (!version) throw fail(409, 'Copy source version is unavailable');
      const next = await versions.insertCopiedVersion(client, copied.id, version, actor);
      await versions.referenceChunks(client, version.chunk_collection_id, version.chunk_ids);
      await versions.copyKeyContexts(client, id, next.id);
      if (id === source.current_version_id) current = next.id;
    }
    if (!current) throw fail(409, 'Copy source has no current version');
    await versions.copyFileShares(client, source.id, copied.id, actor);
    return versions.finishCopy(client, copied.id, current, source, actor);
  }
}
