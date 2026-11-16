// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { OperationFingerprint, type RemotePurgePlan } from './PathOperationPlan.js';

import type { FileRootConfig } from './config.js';
import type { TransactionRunner } from './FilesTransaction.js';
import type { NativeOperationJournal } from './nativeOperationJournal.js';
import type { PathOperationRecovery } from './PathOperationRecovery.js';
import type { PathOperationRepository } from './Repositories/PathOperationRepository.js';
import type { RemotePurgeRepository } from './Repositories/RemotePurgeRepository.js';
import type { EvictionReceipt, FileFingerprint, FilesMutationCoordinator } from './safeFilesystem.js';

/**
 * Applies a replicated permanent purge. Local bytes are first evicted into a journaled retention
 * stage (only when their identity is proven), then metadata is purged in one transaction, then the
 * stage is disposed. Any doubt preserves the bytes and leaves the journal for recovery.
 */
export class RemotePurgeApplier {
  constructor(
    private readonly repository:RemotePurgeRepository,
    private readonly operations:PathOperationRepository,
    private readonly recovery:PathOperationRecovery,
    private readonly transactions:TransactionRunner,
    private readonly rootMutations:Map<string, FilesMutationCoordinator>,
    private readonly rootFor:(collectionId:string)=>FileRootConfig,
    private readonly journal:()=>NativeOperationJournal,
  ) {}

  async apply(entry:any):Promise<void> {
    const collectionId = entry.file.collection_id;
    if (entry.syncAuthority?.canMaterialize !== true) return;
    const hold=await this.repository.activeHold(collectionId,entry.file.id);
    if (hold) throw new Error(`Remote purge is held by active Files path operation ${hold}`);
    const existing=await this.repository.target(entry.file.id,collectionId);
    const root=this.rootFor(collectionId); const mutations=this.rootMutations.get(existing?.root_id??root.id);
    let remoteOperationId:string|undefined; let remotePlan:RemotePurgePlan|undefined;
    if (existing?.path && existing.content_hash) {
      if (!mutations) throw new Error('Remote purge root is unavailable; local bytes were preserved');
      const pinned=await mutations.pinVerified(existing.path,p=>this.recovery.verifyPinned(p,existing.content_hash!));
      const expected:FileFingerprint=pinned.fingerprint;
      try {
        if (expected.size!==Number(existing.size) || expected.mtimeMs!==Number(existing.mtime_ms)) throw new Error('Remote purge cannot prove current watched-file ownership; local bytes were preserved');
      } finally { await pinned.close() }
      remoteOperationId=randomUUID();
      remotePlan={kind:'remote-purge-v1',rootId:existing.root_id!,collectionId,fileId:entry.file.id,sourcePath:existing.path,
        stagePath:`.sulla-trash/.operations/${remoteOperationId}/remote-purge`,versionId:existing.current_version_id,
        revision:String(existing.operation_revision),contentHash:existing.content_hash,fingerprint:OperationFingerprint.serialize(expected),
        lifecycleGeneration:Number(entry.file.lifecycle_generation??0)};
      await this.repository.plan(remoteOperationId,remotePlan);
      let eviction:EvictionReceipt;
      try { eviction=await mutations.evictVerified({source:remotePlan.sourcePath,quarantine:remotePlan.stagePath,verify:p=>this.recovery.verifyPinned(p,remotePlan!.contentHash)}) }
      catch(error) {
        try { await this.recovery.recoverRemotePurge({operation_id:remoteOperationId,state:'publishing',plan:remotePlan,receipts:[]}) }
        catch(recoveryError:any) {
          await this.operations.recordError(remoteOperationId,String(recoveryError?.message??recoveryError)).catch(()=>undefined);
          throw recoveryError;
        }
        throw error;
      }
      if (!OperationFingerprint.same(eviction.fingerprint,expected)) {
        await this.recovery.recoverRemotePurge({operation_id:remoteOperationId,state:'publishing',plan:remotePlan,receipts:[]});
        throw new Error('Remote purge source identity changed before eviction; bytes were restored');
      }
    } else if (existing?.path) throw new Error('Remote purge cannot prove ownership of local bytes; they were preserved');
    let committedReceipt:any;
    try {
      await this.transactions.run('remote-purge', async client => {
        await this.repository.trustReplication(client);
        if (existing && !await this.repository.lockUnchangedTarget(client,entry.file.id,collectionId,existing)) throw new Error('Remote purge target changed; retained bytes were preserved');
        if (remoteOperationId && !await this.repository.lockUnchangedPlan(client,remoteOperationId,entry.file.id,existing!)) throw new Error('Remote purge journal changed; retained bytes were preserved');
        const receipt=existing?await this.repository.lockTrashReceipt(client,entry.file.id,existing.current_version_id):null;
        if (receipt?.state==='completed') {
          const invalidation={undoInvalidatedAt:new Date().toISOString(),invalidatedBy:'remote-authority',reason:'replicated-disposal'};
          const receiptPlan=receipt.folder_plan??{}; receiptPlan.lifecycle={...(receiptPlan.lifecycle??{}),disposal:invalidation};
          await this.operations.saveReceiptPlan(client,receipt.id,receiptPlan);
          const operation=await this.operations.lockOperation(client,receipt.id);
          if (operation) { operation.plan.disposal=invalidation; await this.operations.saveOperationPlan(client,receipt.id,operation.plan) }
        }
        await this.repository.purge(client,{ collectionId, fileId:entry.file.id, path:existing?.path??entry.file.path, lifecycleGeneration:entry.file.lifecycle_generation ?? 0, at:entry.at ?? null });
        if (remoteOperationId && !await this.repository.markCommitted(client,remoteOperationId)) throw new Error('Remote purge journal commit proof could not be recorded');
        committedReceipt = receipt;
      });
      if (remoteOperationId && remotePlan) await this.recovery.recoverRemotePurge({operation_id:remoteOperationId,state:'db-committed',plan:remotePlan,receipts:[]});
      if (committedReceipt?.state==='completed') {
        const disposed=await this.journal().dispose(committedReceipt.id);
        if (disposed.state==='recovery-required') throw new Error(disposed.error??'Remote purge retained artifacts require recovery');
      }
    } catch (error) {
      if (remoteOperationId) {
        const durable=await this.operations.find(remoteOperationId);
        if (durable && ['planned','publishing','db-committed'].includes(durable.state)) await this.recovery.recoverRemotePurge(durable).catch(async recoveryError=>{
          await this.operations.recordError(remoteOperationId!,String((recoveryError as any)?.message??recoveryError)).catch(()=>undefined);
          throw recoveryError;
        });
      }
      throw error;
    }
  }
}
