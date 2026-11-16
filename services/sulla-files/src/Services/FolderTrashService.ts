// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import type { DatabaseOperationAccess } from './DatabaseOperationTypes.js';
import { FolderSubtreeInspector } from './FolderSubtreeInspector.js';
import { OperationFailure } from './OperationFailure.js';
import type { TrashRestoreService } from './TrashRestoreService.js';

const fail = (message:string, code='state-conflict') => OperationFailure.coded(409, message, code);

export interface FolderPurgeInput {
  invalidateUndo:boolean;
  dispose?:(receiptId:string)=>Promise<{state:'none'|'complete'|'recovery-required';error?:string}>;
  drainChunks?:()=>Promise<void>;
}

/** Restores a trashed folder from its receipt, or permanently disposes of it. */
export class FolderTrashService {
  constructor(private readonly context:DatabaseOperationContext, private readonly trash:TrashRestoreService) {}

  async restore(folderId:string, receiptId:string, expectedRevision:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<{
    status:'restored';kind:'folder';id:string;path:string;revision:string;currentTombstone:null;receiptId:string;
  }> {
    const uuid = OperationFailure.uuid;
    if (!uuid.test(folderId) || !uuid.test(receiptId) || !/^\d+$/.test(expectedRevision)) throw Object.assign(new Error('Valid folder, receipt and revision are required'),{status:400});
    const initial = await this.context.receipts.trashCollection(this.context.db, receiptId);
    if (!initial) throw Object.assign(new Error('Trash receipt not found'),{status:404});
    await access.prepare?.(initial.collection_id);
    const execute = () => this.context.transaction.run(async client => {
      const { receipts, subtree, audit } = this.context;
      const { row, plan, files, folders } = await this.lockTrashedSubtree(client, initial.collection_id, receiptId, folderId, expectedRevision, 'Folder Trash receipt is no longer restorable', true);
      for (const file of files) await access.file(client,file.id);
      for (const folder of folders) { await access.path(client,row.collection_id,folder.path); await access.path(client,row.collection_id,plan.folders.find((item:any)=>item.after.folderId===folder.id).before.path) }
      for (const child of [...plan.children].reverse()) {
        const childRow = await receipts.lockById(client, child.operationId);
        if (!childRow) throw fail('Folder child Trash receipt is missing');
        await this.trash.restoreReceipt(client,childRow,actor,FolderSubtreeInspector.metadataAccess(access),false);
      }
      for (const folder of [...plan.folders].reverse()) await subtree.restoreFolder(client, folder.after.folderId, folder.before.path);
      await access.custody?.publish(client,row,true);
      await receipts.markUndoneQuietly(client, row.id);
      await audit.trashRestoreFolder(client, actor, {receiptId:row.id,folderId,path:plan.source});
      const restored = await subtree.findFolder(client, folderId);
      return {status:'restored' as const,kind:'folder' as const,id:restored.id,path:restored.path,revision:String(restored.operation_revision),currentTombstone:null,receiptId:row.id};
    });
    return access.custody?access.custody.run(execute):execute();
  }

  /**
   * Locks the folder Trash receipt and its subtree and proves both are exactly what Trash left:
   * same signature, same root tombstone revision, same tombstoned files and folders.
   */
  private async lockTrashedSubtree(client:pg.PoolClient, collectionId:string, receiptId:string, folderId:string, expectedRevision:string, unavailable:string, restoring:boolean):Promise<{ row:any; plan:any; files:any[]; folders:any[] }> {
    const { receipts, subtree, locks, policy } = this.context;
    await locks.lockNamespace(client, collectionId);
    const row = await receipts.lockTrash(client, receiptId);
    const plan = row?.folder_plan;
    if (!row || row.state!=='completed' || !plan?.source) throw restoring ? fail(unavailable) : Object.assign(new Error(unavailable),{status:409});
    if (restoring && plan.lifecycle?.disposal?.undoInvalidatedAt) throw fail('The retained Folder Trash receipt expired or was explicitly invalidated');
    if (row.permission_signature && row.permission_signature!==await policy.permissionSignature(client,row.collection_id,row.id)) throw fail('Folder permissions or public links changed after Trash');
    const root = plan.folders.find((item:any)=>item.before.folderId===folderId && item.before.path===plan.source);
    if (!root || root.after.revision!==expectedRevision || !root.deleted) throw fail('The folder tombstone changed; refresh Files');
    const files = await subtree.lockFilesById(client, row.collection_id, plan.source);
    const expectedFiles = new Map(plan.children.map((item:any)=>[item.after.fileId,item.after]));
    if (files.length!==expectedFiles.size || files.some(file=>{const expected:any=expectedFiles.get(file.id);return !expected || file.path!==expected.path || file.current_version_id!==expected.versionId || String(file.operation_revision)!==expected.revision || !file.deleted_at})) throw fail('Folder contents changed after Trash');
    const folders = await subtree.lockFoldersById(client, row.collection_id, plan.source);
    if (folders.length!==plan.folders.length || folders.some(folder=>!plan.folders.some((item:any)=>item.after.folderId===folder.id && item.after.path===folder.path && item.after.revision===String(folder.operation_revision) && folder.deleted_at))) throw fail('Folder identity, revision or subtree changed after Trash');
    return { row, plan, files, folders };
  }

  async purge(folderId:string, receiptId:string, expectedRevision:string, actor:FilesIdentity, access:DatabaseOperationAccess, input:FolderPurgeInput):Promise<any> {
    const uuid = OperationFailure.uuid;
    if (!uuid.test(folderId) || !uuid.test(receiptId) || !/^\d+$/.test(expectedRevision) || input.invalidateUndo!==true) {
      throw Object.assign(new Error('Valid folder, receipt, revision and invalidateUndo=true are required'),{status:400});
    }
    const initial = await this.context.receipts.trashCollection(this.context.db, receiptId);
    if (!initial) throw Object.assign(new Error('Folder Trash receipt not found'),{status:404});
    await access.prepare?.(initial.collection_id);
    let committedResult:any;
    const execute = async() => {
      const result = await this.context.transaction.run(client => this.purgeLocked(client, initial.collection_id, folderId, receiptId, expectedRevision, actor, access, input));
      committedResult = result;
      return result;
    };
    let custodyRecoveryFailed = false; let removed:any;
    try { removed = access.custody?await access.custody.run(execute):await execute() }
    catch(error) { if (!committedResult) throw error; removed = committedResult; custodyRecoveryFailed = true }
    const retainedResult = removed.retained
      ? custodyRecoveryFailed
        ? {state:'recovery-required' as const,error:'Retained-artifact cleanup did not complete; exact artifacts were preserved for recovery'}
        : await input.dispose!(receiptId).catch(()=>({state:'recovery-required' as const,error:'Retained-artifact cleanup did not complete; exact artifacts were preserved for recovery'}))
      : {state:'none' as const};
    if (removed.queued && input.drainChunks) await input.drainChunks().catch(()=>undefined);
    const chunksPending = await this.context.purge.chunkGcPending(this.context.db, removed.auditId);
    const common = {kind:'folder' as const,id:folderId,path:removed.path,revision:removed.revision,currentTombstone:null,metadataPurged:true,undo:'invalidated' as const,receiptId};
    if (chunksPending || retainedResult.state==='recovery-required') return {status:'recovery-required' as const,...common,chunks:chunksPending?'pending':'complete',retainedArtifacts:retainedResult.state==='recovery-required'?'preserved':'complete',...(retainedResult.error?{reason:retainedResult.error}:{})};
    return {status:'purged' as const,...common,chunks:'complete',retainedArtifacts:retainedResult.state};
  }

  private async purgeLocked(client:pg.PoolClient, collectionId:string, folderId:string, receiptId:string, expectedRevision:string, actor:FilesIdentity, access:DatabaseOperationAccess, input:FolderPurgeInput):Promise<{ auditId:string; queued:number; retained:boolean; path:string; revision:string }> {
    const { receipts, subtree, purge, grants, audit } = this.context;
    const { row, plan, files, folders } = await this.lockTrashedSubtree(client, collectionId, receiptId, folderId, expectedRevision, 'Folder Trash receipt is no longer disposable', false);
    for (const file of files) await access.file(client,file.id);
    for (const folder of folders) await access.path(client,row.collection_id,folder.path);
    if (files.some(file=>file.disposal_status!=='approved') || (files.length && await purge.anyRetentionActive(client, files.map(file=>file.id)))) throw fail('Every file requires approved disposal with no active retention or lock');
    if (files.length && await grants.activeFileLink(client, files.map(file=>file.id))) throw fail('Active share links must be revoked before folder disposal');
    const operation = await purge.lockPathOperation(client, row.id);
    if (operation && (!['completed','undone','rolled-back'].includes(operation.state)||operation.last_error)) throw fail('Native Folder Trash journal requires recovery before disposal');
    if (operation && !input.dispose) throw Object.assign(new Error('Native retained-artifact disposal is unavailable; artifacts were preserved'),{status:503});
    for (const child of plan.children) {
      const childRow = await receipts.lockTrash(client, child.operationId);
      if (!childRow || childRow.state!=='completed' || childRow.after_state?.versionId!==child.after.versionId) throw fail('A child Trash receipt changed');
    }
    const invalidation = plan.lifecycle?.disposal??{undoInvalidatedAt:new Date().toISOString(),invalidatedBy:actor.userId,reason:'explicit-folder-disposal'};
    plan.lifecycle = {...(plan.lifecycle??{}),disposal:invalidation};
    await receipts.setFolderPlan(client, row.id, plan);
    for (const child of plan.children) await receipts.invalidateChild(client, child.operationId, JSON.stringify(invalidation));
    if (operation) { operation.plan.disposal = invalidation; await purge.savePathOperationPlan(client, row.id, operation.plan) }
    await purge.lockVersions(client);
    const fileIds = files.map(file=>file.id);
    const chunks = fileIds.length ? await purge.chunksOf(client, fileIds) : [];
    const auditRow = await audit.folderDisposalPurge(client, actor, {folderId,path:plan.source,collectionId:row.collection_id,fileIds,receiptId:row.id,physicalChunkGc:chunks.length?'pending':'not-required'});
    for (const file of files) await purge.recordPurgeTombstone(client, row.collection_id, file);
    if (fileIds.length) await purge.purgeFiles(client, fileIds);
    for (const folder of [...plan.folders].reverse()) await subtree.deleteFolder(client, folder.after.folderId);
    let queued = 0;
    for (const chunk of chunks) {
      const refs = await purge.chunkReferences(client, chunk.chunk_collection_id, chunk.chunk_id);
      await purge.setChunkRefcount(client, chunk.chunk_collection_id, chunk.chunk_id, refs);
      if (!refs) { await purge.queueChunkGc(client, chunk.chunk_collection_id, chunk.chunk_id, auditRow.id); queued++ }
    }
    return {auditId:auditRow.id,queued,retained:Boolean(operation),path:plan.source,revision:expectedRevision};
  }
}
