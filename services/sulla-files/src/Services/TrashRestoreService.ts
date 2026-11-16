// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import { OperationRecords, type DatabaseOperationAccess, type DatabaseOperationState, type TrashRestoreRequest,
  type TrashRestoreResult } from './DatabaseOperationTypes.js';
import { OperationFailure } from './OperationFailure.js';

const fail = OperationFailure.of;

/** Moves single files to Trash without a receipt and restores trashed files (by receipt or by lineage). */
export class TrashRestoreService {
  constructor(private readonly context:DatabaseOperationContext) {}

  /** Restore one exact Trash tombstone. Receipt restore never invokes its batch. */
  async restoreReceipt(client:pg.PoolClient, row:any, actor:FilesIdentity, access:DatabaseOperationAccess, publish = true):Promise<any> {
    const { policy, versions, files, audit, receipts } = this.context;
    if (row.action!=='trash' || row.state!=='completed' || row.folder_plan?.source) throw fail(409,'The Trash receipt is not available for file restore');
    if (row.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt) throw fail(409,'The retained Trash receipt expired or was explicitly invalidated');
    if (row.permission_signature && row.permission_signature!==await policy.permissionSignature(client,row.collection_id,row.id)) throw fail(409,'Permissions or public links changed after Trash');
    const file = await policy.lockedFile(client,row.file_id,access);
    const expected = row.after_state as DatabaseOperationState; const before = row.before_state as DatabaseOperationState;
    if (JSON.stringify(OperationRecords.snapshot(file))!==JSON.stringify(OperationRecords.expected(expected, row.collection_id))) {
      throw fail(409,'The Trash tombstone changed; refresh Files');
    }
    policy.editable(file,actor);
    await access.path(client,before.collectionId??row.collection_id,before.path);
    const source = await versions.lockTrashParent(client, before.versionId, expected.versionId, file.id);
    if (!source) throw fail(409,'The exact pre-Trash version is no longer available');
    const version = await versions.insertRestoredVersion(client, file, source, actor);
    await versions.referenceManifestChunks(client, source.chunk_collection_id, source.manifest_hash);
    const updated = await files.restoreHead(client, file.id, version.id, source.size, file.current_version_id);
    if (!updated) throw fail(409,'The Trash tombstone changed while restoring');
    await audit.journalRestore(client, file.collection_id, file.id, version.id);
    if (publish) await access.custody?.publish(client,row,true);
    await receipts.markUndoneQuietly(client, row.id);
    return updated;
  }

  async restoreFile(fileId:string, actor:FilesIdentity, access:DatabaseOperationAccess, request:TrashRestoreRequest = {}):Promise<TrashRestoreResult> {
    const uuid = OperationFailure.uuid;
    if (!uuid.test(fileId)) throw fail(400, 'fileId must be a UUID');
    if (request.expectedVersionId !== undefined && (typeof request.expectedVersionId !== 'string' || !uuid.test(request.expectedVersionId))) throw fail(400, 'expectedVersionId must be a UUID');
    if (request.expectedRevision !== undefined && (typeof request.expectedRevision !== 'string' || !/^\d+$/.test(request.expectedRevision))) throw fail(400,'expectedRevision must be a decimal string');
    if (request.receiptId !== undefined && (typeof request.receiptId !== 'string' || !uuid.test(request.receiptId))) throw fail(400,'receiptId must be a UUID');
    const collection = await this.context.files.collectionOf(this.context.db, fileId);
    if (collection) await access.prepare?.(collection.collection_id);
    const execute = () => this.context.transaction.run(client => this.restoreLocked(client, fileId, actor, access, request));
    return access.custody?access.custody.run(execute):execute();
  }

  private async restoreLocked(client:pg.PoolClient, fileId:string, actor:FilesIdentity, access:DatabaseOperationAccess, request:TrashRestoreRequest):Promise<TrashRestoreResult> {
    const { files, versions, receipts, audit, policy } = this.context;
    const file = await files.lockById(client, fileId);
    if (!file) throw fail(404, 'file not found');
    await access.file(client, fileId);
    if (!file.deleted_at || (request.expectedVersionId !== undefined && file.current_version_id !== request.expectedVersionId) ||
      (request.expectedRevision!==undefined && String(file.operation_revision)!==request.expectedRevision)) throw fail(409, 'The trashed file changed; refresh Files');
    policy.editable(file, actor);
    // The head is normally the trash tombstone. A write that landed after Trash
    // (upload, sync, import) can move the head to live content while deleted_at
    // stays set, and the Trash list still shows the file. Restore that live head.
    const head = await versions.lockVersion(client, file.current_version_id, file.id);
    const tombstone = head?.deleted === true ? head : null;
    const native = await files.hasNativeRoot(client, file.collection_id);
    const receiptRow = request.receiptId ? await receipts.lockFileTrash(client, request.receiptId, file.id) : null;
    if (request.receiptId && !receiptRow) throw fail(409,'The selected Trash receipt does not match this file');
    if (receiptRow) {
      if (!tombstone || receiptRow.after_state?.versionId!==tombstone.id) throw fail(409,'The selected Trash receipt is not the current tombstone');
      const updated = await this.restoreReceipt(client,receiptRow,actor,access,true);
      return {status:'restored',kind:'file',id:updated.id,path:updated.path,revision:String(updated.operation_revision),currentTombstone:null,receiptId:receiptRow.id,versionId:updated.current_version_id};
    }
    if (native) throw Object.assign(fail(409,'Native Trash Restore requires its exact retained receipt'),{code:'trash-receipt-required'});
    // A live head (stale Trash flag) is itself the latest content, so start there.
    const start = tombstone ? tombstone.parent_version_id : (head?.id ?? null);
    const source = start ? await versions.lockRestorableAncestor(client, start, file.id) : undefined;
    if (!source) throw fail(409, 'Nothing in this file can be restored: no non-deleted version remains. Version history is kept.');
    // Tombstone head: append a restore version. Live head (stale Trash flag): it already
    // holds the latest content, so add no version and keep chunk refcounts untouched.
    let restoredVersionId = head.id;
    if (tombstone) {
      const version = await versions.insertRestoredVersion(client, file, source, actor);
      await versions.referenceManifestChunks(client, source.chunk_collection_id, source.manifest_hash);
      restoredVersionId = version.id;
    }
    const updated = await files.restoreHead(client, file.id, restoredVersionId, source.size, file.current_version_id);
    if (!updated) throw fail(409, 'The trash tombstone changed while restoring');
    await audit.journalRestore(client, file.collection_id, file.id, restoredVersionId);
    await audit.trashRestore(client, actor, file.id, restoredVersionId, { tombstoneVersionId: tombstone?.id ?? null, sourceVersionId: source.id, staleTrashFlag: !tombstone });
    return {status:'restored',kind:'file',id:updated.id,path:updated.path,revision:String(updated.operation_revision),currentTombstone:null,receiptId:null,versionId:restoredVersionId};
  }

  async trashWithoutReceipt(fileId:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<void> {
    if (!OperationFailure.uuid.test(fileId)) throw fail(400, 'fileId must be a UUID');
    const { files, versions, audit, policy } = this.context;
    const collection = await files.collectionOf(this.context.db, fileId);
    if (collection) await access.prepare?.(collection.collection_id);
    return this.context.transaction.run(async client => {
      const file = await files.lockById(client, fileId);
      if (!file) throw fail(404, 'file not found');
      await access.file(client, fileId);
      if (file.deleted_at) throw fail(409, 'The file is already in Trash');
      policy.editable(file, actor);
      const version = await versions.insertTrashTombstone(client, file, actor);
      await files.markTrashedQuietly(client, file.id, version.id);
      await audit.journalDelete(client, file.collection_id, file.id, version.id);
      await audit.trash(client, actor, file.id, version.id, { parentVersionId: file.current_version_id });
    });
  }
}
