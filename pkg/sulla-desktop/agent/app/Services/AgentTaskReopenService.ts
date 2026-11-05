// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import type { Clock } from '@sulla/foundation';
import type { AgentJobRepository } from '../Repositories/AgentJobRepository';
import type { AgentJobResultHistoryRepository } from '../Repositories/AgentJobResultHistoryRepository';
import { AgentTaskReopenPolicy, type AgentTaskReopenRefusalReason } from '../ValueObjects/AgentTaskReopenPolicy';
import type { AgentInbox, AgentInboxEntry } from '../../services/AgentInbox';
import type { HiddenAgentTaskRunnerRegistry } from '../../services/HiddenAgentTaskRunner';
import type { AgentJobResult } from '../../tools/agents/jobRegistry';

export type AgentTaskReopenOutcome =
  | { reopened: true; generation: number; joined?: boolean; fallback?: boolean }
  | { reopened: false; reason: AgentTaskReopenRefusalReason | 'missing_runner' | 'not_found' | 'already_reopening' };

export interface AgentTaskReopenSettlement {
  settle(jobId: string, taskIndex: number, result: AgentJobResult, generation: number): Promise<void>;
  fail(jobId: string, taskIndex: number, error: Error, generation: number): Promise<void>;
}

/** Claims and launches one additional execution generation for a settled hidden task. */
export class AgentTaskReopenService {
  constructor(
    private readonly jobs: AgentJobRepository,
    private readonly history: AgentJobResultHistoryRepository,
    private readonly inbox: Pick<AgentInbox, 'receive'>,
    private readonly runners: HiddenAgentTaskRunnerRegistry,
    private readonly clock: Clock,
    private readonly settlement: AgentTaskReopenSettlement,
    private readonly policy = new AgentTaskReopenPolicy(),
  ) {}

  async reopen(jobId: string, taskIndex: number, message: string, managerAgentId: string): Promise<AgentTaskReopenOutcome> {
    const job = await this.jobs.job(jobId);
    const task = job?.tasks[taskIndex];
    if (!job || !task) return { reopened: false, reason: 'not_found' };
    const runner = this.runners.find(jobId, taskIndex);
    const generation = task.generation ?? 1;
    const decision = this.policy.decide(task.status, task.reopenCount ?? 0, Boolean(task.reopenLeaseId));
    if (!decision.allowed) return { reopened: false, reason: decision.reason };

    // Reading history here is deliberate: it verifies the immutable prior
    // generation remains addressable before its latest projection is rotated.
    await this.history.forTask(jobId, taskIndex);
    const claim = await this.jobs.claimReopen(jobId, taskIndex, generation);
    if (!claim) {
      const current = (await this.jobs.job(jobId))?.tasks[taskIndex];
      if (current?.status === 'running' && (current.generation ?? 1) > generation) {
        await this.inbox.receive(this.entry(jobId, taskIndex, current.threadId, current.agentId, current.generation ?? generation + 1, message, managerAgentId));
        return { reopened: true, generation: current.generation ?? generation + 1, joined: true };
      }
      return { reopened: false, reason: 'already_reopening' };
    }

    const feedback = runner ? message : this.fallbackPrompt(task.prompt, task.result, message);
    const entry = this.entry(jobId, taskIndex, task.threadId, task.agentId, claim.generation, feedback, managerAgentId);
    if (!runner) {
      await this.inbox.receive(entry);
      return { reopened: true, generation: claim.generation, fallback: true };
    }
    const run = runner.run({ task: { ...task, generation: claim.generation }, taskIndex, threadId: task.threadId ?? '', generation: claim.generation });
    await this.inbox.receive(entry);
    void run.then(result => this.settlement.settle(jobId, taskIndex, result, claim.generation))
      .catch(error => this.settlement.fail(jobId, taskIndex, error as Error, claim.generation))
      .finally(() => this.jobs.releaseReopenLease(jobId, taskIndex, claim.generation, claim.leaseId));
    void this.clock.now();
    return { reopened: true, generation: claim.generation };
  }

  private entry(jobId: string, taskIndex: number, threadId: string | undefined, agentId: string, generation: number, message: string, managerAgentId: string): AgentInboxEntry {
    return {
      envelope: {
        from: managerAgentId,
        kind: 'parent',
        body: message,
        ids: { messageId: randomUUID(), jobId, taskIndex, threadId, generation },
      },
      target: { channel: agentId, threadId, agentId },
    };
  }

  private fallbackPrompt(brief: string, priorResult: unknown, feedback: string): string {
    return `Your previous provider session or workspace was lost. Continue on this same Sulla thread with a fresh runtime.\n\nOriginal brief:\n${ brief }\n\nPrior result:\n${ JSON.stringify(priorResult ?? null) }\n\nManager feedback:\n${ feedback }`;
  }
}
