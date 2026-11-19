// SPDX-License-Identifier: GPL-2.0-or-later
import { resultTracking, type ResultReference, type ResultTracking } from '../../shared/agentResults/AgentResultCard';
import { AgentJobMutationQueue } from '../app/Services/AgentStateService';

import type { DecisionRecord } from '../../shared/decisions';
import type { AgentJob } from '../tools/agents/jobRegistry';

export interface ResultTrackingStore {
  job(id: string): Promise<AgentJob | undefined>;
  update(jobId: string, taskIndex: number, patch: ResultTracking): Promise<void>;
  decision(id: string): Promise<DecisionRecord | undefined>;
}

/** Correlation metadata only. Never starts, settles, answers or wakes anything. */
export class ResultTrackingService {
  private static readonly owners = new AgentJobMutationQueue();
  constructor(private readonly store: ResultTrackingStore) {}

  async validateFollowUp(ref: ResultReference, ownerThread: string): Promise<void> {
    if (!resultTracking({ followUpOf: ref }).followUpOf) throw new Error('A valid original jobId and taskIndex are required.');
    const source = await this.store.job(ref.jobId);
    if (!ownerThread || source?.parentThreadId !== ownerThread || !source.tasks[ref.taskIndex]) throw new Error('Original task must belong to this manager conversation.');
  }

  async link(target: ResultReference, patch: ResultTracking, ownerThread: string): Promise<void> {
    return ResultTrackingService.owners.run(ownerThread, () => this.writeLink(target, patch, ownerThread));
  }

  private async writeLink(target: ResultReference, patch: ResultTracking, ownerThread: string): Promise<void> {
    if (typeof target.jobId !== 'string' || !Number.isInteger(target.taskIndex) || target.taskIndex < 0) throw new Error('A valid follow-up jobId and taskIndex are required.');
    const job = await this.store.job(target.jobId);
    if (!ownerThread || job?.parentThreadId !== ownerThread || !job.tasks[target.taskIndex]) throw new Error('Follow-up task must belong to this manager conversation.');
    if (!patch.followUpOf && !patch.decisionIds) throw new Error('Supply followUpOf or decisionIds.');
    if (patch.followUpOf) {
      await this.validateFollowUp(patch.followUpOf, ownerThread);
      let ref: ResultReference | undefined = patch.followUpOf;
      const visited = new Set<string>([`${ target.jobId }:${ target.taskIndex }`]);
      while (ref) {
        const key = `${ ref.jobId }:${ ref.taskIndex }`;
        if (visited.has(key) || visited.size > 100) throw new Error('Result links must not form a cycle.');
        visited.add(key);
        ref = (await this.store.job(ref.jobId))?.tasks[ref.taskIndex]?.followUpOf;
      }
    }
    if (patch.decisionIds) {
      if (!Array.isArray(patch.decisionIds) || patch.decisionIds.length > 20 || patch.decisionIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('decisionIds must contain at most 20 existing decision IDs.');
      for (const id of patch.decisionIds) {
        const decision = await this.store.decision(id);
        if (!decision || ![ownerThread, job.tasks[target.taskIndex].threadId].includes(decision.conversationId)) throw new Error('Decision must belong to this manager or worker conversation.');
      }
    }
    const prior = job.tasks[target.taskIndex];
    if (prior.followUpOf && patch.followUpOf && (prior.followUpOf.jobId !== patch.followUpOf.jobId || prior.followUpOf.taskIndex !== patch.followUpOf.taskIndex)) throw new Error('An existing follow-up link cannot be reassigned.');
    await this.store.update(target.jobId, target.taskIndex, resultTracking(patch));
    const saved = (await this.store.job(target.jobId))?.tasks[target.taskIndex];
    if (!saved || (patch.followUpOf && (saved.followUpOf?.jobId !== patch.followUpOf.jobId || saved.followUpOf?.taskIndex !== patch.followUpOf.taskIndex)) ||
      (patch.decisionIds && JSON.stringify(resultTracking(saved).decisionIds) !== JSON.stringify(resultTracking(patch).decisionIds))) {
      throw new Error('Result links could not be confirmed; the task may no longer be available.');
    }
  }
}
