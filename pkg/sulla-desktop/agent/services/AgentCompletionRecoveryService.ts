// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { completionInboxStore, CompletionInboxStore } from './AgentCompletionInbox';

import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

export interface PendingCompletionRepository {
  pendingCompletions(): Promise<AgentJob[]>;
}

/** Decides whether a task result has already entered a parent turn. */
export class CompletionDeliveryPolicy {
  isDelivered(job: AgentJob, task: AgentJobTask): boolean {
    return Boolean(task.completionDeliveredAt || job.completionDeliveredAt);
  }
}

/**
 * Re-deliver completed delegation results (hidden or tab) after process
 * recovery, in the same wake format as the live delivery path.
 * Delivery is idempotent at the job level and remains pending if the message
 * bus is unavailable, so a later boot can retry it.
 */
export class AgentCompletionRecoveryService {
  private recoveryPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly repository: PendingCompletionRepository,
    private readonly inbox: CompletionInboxStore,
    private readonly deliveryPolicy: CompletionDeliveryPolicy,
  ) {}

  recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.recoverPending().finally(() => {
      this.recoveryPromise = null;
    });
    return this.recoveryPromise;
  }

  private async recoverPending(): Promise<void> {
    const jobs = await this.repository.pendingCompletions();
    for (const job of jobs) {
      if (this.inFlight.has(job.jobId) || !job.parentChannel || !job.parentThreadId) continue;
      this.inFlight.add(job.jobId);
      try {
        job.tasks.forEach((task, taskIndex) => {
          const result = task.completion ?? job.results[taskIndex];
          if (result && !this.deliveryPolicy.isDelivered(job, task)) {
            this.inbox.enqueue(job.parentChannel!, job.parentThreadId!, { jobId: job.jobId, taskIndex, results: [result] });
          }
        });
      } catch (error) {
        console.warn(`[AgentCompletionRecovery] delivery failed for ${ job.jobId }; will retry:`, error);
      } finally {
        this.inFlight.delete(job.jobId);
      }
    }
  }
}

const recoveryService = new AgentCompletionRecoveryService(agentJobProvider.jobs, completionInboxStore, new CompletionDeliveryPolicy());

/** Thin boot adapter retained for BackendGraphWebSocketService. */
export const recoverPendingAgentCompletions = (): Promise<void> => recoveryService.recover();
