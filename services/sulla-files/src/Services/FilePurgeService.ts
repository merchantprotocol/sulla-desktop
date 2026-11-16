// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { LifecycleHttpError } from './LifecycleHttpError.js';

import type { FilesIdentity } from '../auth.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { ChunkGcRepository } from '../Repositories/ChunkGcRepository.js';
import type { DocumentLifecycleRepository } from '../Repositories/DocumentLifecycleRepository.js';
import type { FilePurgeRepository } from '../Repositories/FilePurgeRepository.js';
import type { ChunkGcDrainer, DeleteChunk } from './ChunkGcDrainer.js';
import type pg from 'pg';

export type DisposeTrashReceipt = (receiptId:string)=>Promise<{ state:'none' | 'complete' | 'recovery-required'; error?:string }>;

export interface PurgeRequest {
  expectedRevision?:unknown;
  currentTombstone?:{ id?:unknown };
  invalidateUndo?:unknown;
}

export interface PurgeOutcome { status:200 | 202; body:Record<string, unknown> }

/**
 * Permanent disposal of a trashed file whose disposal was approved and which has no active
 * retention, lock or share link: removes its metadata, writes a purge tombstone and audit
 * record, queues unreferenced chunks for GC, and invalidates a retained Trash receipt.
 */
export class FilePurgeService {
  constructor(
    private readonly db:Pick<pg.Pool, 'query'>,
    private readonly lifecycle:DocumentLifecycleRepository,
    private readonly purges:FilePurgeRepository,
    private readonly gc:ChunkGcRepository,
    private readonly drainer:ChunkGcDrainer,
    private readonly transactions:TransactionRunner,
  ) {}

  async purge(fileId:string, actor:FilesIdentity, body:PurgeRequest | undefined, deleteChunk:DeleteChunk, disposeTrashReceipt?:DisposeTrashReceipt):Promise<PurgeOutcome> {
    const removed = await this.transactions.run('trash-purge', client => this.purgeLocked(client, fileId, actor, body, Boolean(disposeTrashReceipt)));
    const retainedResult=removed.retained&&removed.receiptId
      ? await disposeTrashReceipt!(removed.receiptId).catch(() => ({state:'recovery-required' as const,error:'Retained-artifact cleanup did not complete; exact artifacts were preserved for recovery'}))
      : {state:'none' as const};
    if (removed.queued) await this.drainer.drain(deleteChunk).catch(() => undefined);
    const chunksPending=await this.gc.hasPendingForAudit(this.db, removed.auditId);
    const common={kind:'file',id:removed.id,path:removed.path,revision:removed.revision,currentTombstone:null,metadataPurged:true};
    if (chunksPending || retainedResult.state==='recovery-required') return { status: 202, body: {status:'recovery-required',...common,
      chunks:chunksPending?'pending':'complete',retainedArtifacts:retainedResult.state==='recovery-required'?'preserved':'complete',undo:removed.receiptId?'invalidated':'unavailable',receiptId:removed.receiptId,
      ...('error' in retainedResult && retainedResult.error?{reason:retainedResult.error}:{})} };
    return { status: 200, body: {status:'purged',...common,chunks:'complete',retainedArtifacts:retainedResult.state,undo:removed.receiptId?'invalidated':'unavailable',receiptId:removed.receiptId} };
  }

  private async purgeLocked(client:pg.PoolClient, fileId:string, actor:FilesIdentity, body:PurgeRequest | undefined, canDisposeRetained:boolean) {
    const file = await this.lifecycle.lockFile(client, fileId);
    if (!file) throw LifecycleHttpError.of(404, 'file not found');
    if (!file.deleted_at) throw LifecycleHttpError.of(409, 'only trashed files can be purged');
    const expectedRevision=String(body?.expectedRevision??''); const expectedTombstone=String(body?.currentTombstone?.id??'');
    if (!/^\d+$/.test(expectedRevision) || expectedRevision!==String(file.operation_revision) || expectedTombstone!==String(file.current_version_id)) throw LifecycleHttpError.of(409,'Trash changed; refresh before permanent disposal');
    const active = await this.lifecycle.retentionActive(client, file.id);
    if (active || file.disposal_status !== 'approved') throw LifecycleHttpError.of(409, 'approved disposal with no active retention or lock is required');
    if (await this.purges.hasActiveShareLink(client, file.id)) throw LifecycleHttpError.of(409, 'active share links must be revoked before disposal');
    const receipt=await this.purges.lockTrashReceipt(client, file.id, file.current_version_id);
    let retained=false;
    if (receipt?.state==='completed') {
      if (body?.invalidateUndo!==true) throw LifecycleHttpError.of(409,'Permanent disposal must explicitly invalidate the retained Trash receipt');
      const operation=await this.purges.lockPathOperation(client, receipt.id);
      if (operation && (!['completed','undone','rolled-back'].includes(operation.state) || operation.last_error)) throw LifecycleHttpError.of(409,'Native Trash journal requires recovery before disposal');
      if (operation && !canDisposeRetained) throw LifecycleHttpError.of(503,'Native retained-artifact disposal is unavailable; artifacts were preserved');
      const invalidation={undoInvalidatedAt:new Date().toISOString(),invalidatedBy:actor.userId,reason:'explicit-disposal'};
      const receiptPlan=receipt.folder_plan??{}; receiptPlan.lifecycle={...(receiptPlan.lifecycle??{}),disposal:invalidation};
      await this.purges.updateReceiptPlan(client, receipt.id, receiptPlan);
      if (operation) { const plan=operation.plan; plan.disposal=invalidation; await this.purges.updateOperationPlan(client, receipt.id, plan); retained=true }
    }
    await this.gc.lockVersionsTable(client);
    const chunks = await this.purges.fileChunks(client, file.id);
    const versionIds = await this.purges.versionIds(client, file.id);
    const auditId = await this.purges.insertPurgeAudit(client, actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, { fileId: file.id, collectionId: file.collection_id, path: file.path, versionIds, physicalChunkGc: chunks.rowCount ? 'pending' : 'not-required' });
    await this.purges.upsertTombstone(client, file.collection_id, file.id, file.path, Number(file.lifecycle_generation) + 1);
    await this.purges.deleteFileRows(client, file.id);
    let queued = 0;
    for (const chunk of chunks.rows) {
      const refs = await this.gc.countReferences(client, chunk.chunk_collection_id, chunk.chunk_id);
      await this.gc.setRefcount(client, chunk.chunk_collection_id, chunk.chunk_id, refs);
      if (refs === 0) { await this.gc.queue(client, chunk.chunk_collection_id, chunk.chunk_id, auditId); queued++ }
    }
    if (!queued) await this.gc.markAuditChunkGc(client, auditId, 'not-required');
    return { auditId,queued,receiptId:receipt?.id??null,retained,id:file.id,path:file.path,revision:String(file.operation_revision) };
  }
}
