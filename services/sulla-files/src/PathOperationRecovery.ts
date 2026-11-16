// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { OperationFingerprint, type PathOperationPlanEntry, type PathOperationReceipt, type PathOperationRow, type RemotePurgePlan } from './PathOperationPlan.js';

import type { NativeOperationJournal } from './nativeOperationJournal.js';
import type { PathOperationRepository } from './Repositories/PathOperationRepository.js';
import type { EvictionReceipt, FilesMutationCoordinator, PinnedRegularFile, PublicationReceipt } from './safeFilesystem.js';

/**
 * Reconciles durable native path operations (move/copy publications, remote purges, v2/v3 journal
 * entries) before the watcher may infer changes from the folder. Committed work is finished,
 * uncommitted work is rolled back, and anything that cannot be proven is preserved with an error.
 */
export class PathOperationRecovery {
  constructor(
    private readonly repository:PathOperationRepository,
    private readonly mutations:FilesMutationCoordinator,
    private readonly rootMutations:Map<string, FilesMutationCoordinator>,
    private readonly journal:()=>NativeOperationJournal,
  ) {}

  /** Reconcile durable native publications before the watcher can infer changes. */
  async recoverAll():Promise<void> {
    return this.mutations.runExclusive(['.sulla-trash/.operations'], async() => {
      const rows = await this.repository.unfinished();
      for (const row of rows) {
        try {
          if ((row.plan as RemotePurgePlan)?.kind==='remote-purge-v1') { await this.recoverRemotePurge(row); continue }
          if ([2,3].includes((row.plan as any)?.version)) { await this.journal().recover(row as any); continue }
          const plan = Array.isArray(row.plan) ? row.plan : [];
          if (!plan.length) throw new Error('Path operation has no recoverable plan');
          const receipts = Array.isArray(row.receipts) ? row.receipts : [];
          if (row.state === 'db-committed') await this.finishCommitted(plan, receipts);
          else await this.rollbackUncommitted(plan, receipts);
          await this.repository.markCompleted(row.operation_id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.repository.recordError(row.operation_id, message);
          throw new Error(`Files path operation ${ row.operation_id } requires preserved-artifact reconciliation: ${ message }`);
        }
      }
      for (const disposal of await this.repository.awaitingDisposal()) {
        const result=await this.journal().dispose(disposal.operation_id);
        if (result.state==='recovery-required') throw new Error(result.error??`Trash receipt ${disposal.operation_id} artifact disposal requires recovery`);
      }
    });
  }

  async recoverRemotePurge(input:PathOperationRow):Promise<void> {
    const row=await this.repository.find(input.operation_id);
    if (!row) throw new Error('Remote purge journal is missing; retained bytes were preserved');
    if (row.state==='completed' || row.state==='rolled-back') return;
    if (!['planned','publishing','db-committed'].includes(row.state) || row.plan?.kind!=='remote-purge-v1') throw new Error('Remote purge journal state is invalid; retained bytes were preserved');
    const plan=row.plan as RemotePurgePlan; const mutations=this.rootMutations.get(plan.rootId);
    if (!mutations) throw new Error(`Remote purge root ${plan.rootId} is unavailable; retained bytes were preserved`);
    const verify=(p:PinnedRegularFile)=>this.verifyPinned(p,plan.contentHash);
    const expected=OperationFingerprint.deserialize(plan.fingerprint);
    if (row.state==='db-committed') {
      if (await this.repository.fileStillLive(plan.fileId,plan.collectionId,plan.sourcePath)) {
        throw new Error('Remote purge metadata is still live; retained bytes were preserved');
      }
      const tombstone=await this.repository.purgeTombstone(plan.fileId);
      if (!tombstone || tombstone.collection_id!==plan.collectionId || tombstone.path!==plan.sourcePath || Number(tombstone.lifecycle_generation)<plan.lifecycleGeneration) {
        throw new Error('Remote purge commit proof is missing or changed; retained bytes were preserved');
      }
      if (await mutations.exists(plan.stagePath)) await mutations.disposeRetainedFile(plan.stagePath,expected,verify);
      await this.repository.completeCommittedPurge(row.operation_id);
      return;
    }
    const sourceExists=await mutations.exists(plan.sourcePath); const stageExists=await mutations.exists(plan.stagePath);
    if (sourceExists && stageExists) throw new Error('Remote purge source and retained stage both exist; both were preserved');
    if (!sourceExists && !stageExists) throw new Error('Remote purge source and retained stage are both missing');
    if (stageExists) await mutations.recoverEviction({source:plan.sourcePath,quarantine:plan.stagePath,fingerprint:expected},verify);
    await this.repository.rollBackPurge(row.operation_id);
  }

  private coordinatorFor(plan:PathOperationPlanEntry[]):FilesMutationCoordinator {
    const mutations = this.rootMutations.get(plan[0]?.rootId ?? 'default');
    if (!mutations || plan.some(entry => (entry.rootId ?? 'default') !== (plan[0]?.rootId ?? 'default'))) throw new Error('Path operation root is unavailable or inconsistent');
    return mutations;
  }

  private async finishCommitted(plan:PathOperationPlanEntry[], receipts:PathOperationReceipt[]):Promise<void> {
    const mutations = this.coordinatorFor(plan);
    for (const entry of plan) {
      const receipt = this.receiptFor(entry, receipts);
      if (!receipt?.fingerprint) throw new Error(`Committed publication receipt is missing: ${ entry.targetPath }`);
      const fingerprint = OperationFingerprint.deserialize(receipt.fingerprint);
      if (!await mutations.exists(entry.targetPath)) throw new Error(`Committed target is missing: ${ entry.targetPath }`);
      const target = await mutations.pin(entry.targetPath);
      try {
        if (!OperationFingerprint.same(target.fingerprint, fingerprint)) throw new Error(`Committed target identity changed: ${ entry.targetPath }`);
        await this.verifyPinned(target, entry.contentHash);
      } finally { await target.close() }
      if (await mutations.exists(entry.stagePath)) {
        const staged = await mutations.pin(entry.stagePath);
        try {
          if (!OperationFingerprint.same(staged.fingerprint, fingerprint)) throw new Error(`Committed stage identity changed: ${ entry.stagePath }`);
          await this.verifyPinned(staged, entry.contentHash);
        } finally { await staged.close() }
        await mutations.finalizePublication({ staged: entry.stagePath, target: entry.targetPath, fingerprint });
      }
    }
  }

  private async rollbackUncommitted(plan:PathOperationPlanEntry[], receipts:PathOperationReceipt[]):Promise<void> {
    const mutations = this.coordinatorFor(plan);
    for (const entry of [...plan].reverse()) {
      const durableReceipt = this.receiptFor(entry, receipts);
      const stageExists = await mutations.exists(entry.stagePath);
      if (await mutations.exists(entry.targetPath) && (durableReceipt?.fingerprint || stageExists)) {
        let fingerprint = durableReceipt?.fingerprint ? OperationFingerprint.deserialize(durableReceipt.fingerprint) : undefined;
        if (!fingerprint) {
          const [stage, target] = await Promise.all([mutations.pin(entry.stagePath), mutations.pin(entry.targetPath)]);
          try {
            if (!OperationFingerprint.sameIdentity(stage.fingerprint, target.fingerprint)) throw new Error(`Uncommitted target is not owned by its recovery stage: ${ entry.targetPath }`);
            await Promise.all([this.verifyPinned(stage, entry.contentHash), this.verifyPinned(target, entry.contentHash)]);
            fingerprint = target.fingerprint;
          } finally { await Promise.all([stage.close(), target.close()]) }
        }
        await mutations.rollbackPublication(
          { staged: entry.stagePath, target: entry.targetPath, fingerprint },
          pinned => this.verifyPinned(pinned, entry.contentHash),
        );
      }
      if (entry.kind === 'move' && await mutations.exists(entry.stagePath)) {
        const staged = await mutations.pin(entry.stagePath);
        const receipt:EvictionReceipt = { source: entry.sourcePath, quarantine: entry.stagePath, fingerprint: staged.fingerprint };
        await staged.close();
        await mutations.recoverEviction(receipt, pinned => this.verifyPinned(pinned, entry.contentHash));
      } else if (entry.kind === 'copy' && await mutations.exists(entry.stagePath)) {
        const staged = await mutations.pin(entry.stagePath);
        const receipt:PublicationReceipt = { staged: entry.stagePath, target: entry.targetPath, fingerprint: staged.fingerprint };
        await staged.close();
        await mutations.finalizePublication(receipt);
      }
    }
  }

  private receiptFor(entry:PathOperationPlanEntry, receipts:PathOperationReceipt[]):PathOperationReceipt | undefined {
    return receipts.find(receipt => receipt.published && receipt.fileId === entry.fileId && receipt.stagePath === entry.stagePath && receipt.targetPath === entry.targetPath);
  }

  /** The pinned artifact still has the expected bytes and has not changed while being read. */
  async verifyPinned(pinned:PinnedRegularFile, expectedHash:string):Promise<void> {
    const hash = createHash('sha256');
    for await (const chunk of pinned.createReadStream()) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash) throw new Error(`Recovery artifact changed: ${ pinned.relativePath }`);
    await pinned.assertUnchanged();
  }
}
