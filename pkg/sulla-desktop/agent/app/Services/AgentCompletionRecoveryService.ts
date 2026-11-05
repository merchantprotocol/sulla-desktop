// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import { AgentCompletionInboxService } from './AgentCompletionInboxService';

export interface PendingCompletionSource {
  getPendingCompletions?(): Promise<AgentJob[]>;
  pendingCompletions?(): Promise<AgentJob[]>;
}

/** Decides whether a task result has already entered a parent turn. */
export class CompletionDeliveryPolicy {
  isDelivered(job: AgentJob, task: AgentJobTask): boolean {
    return Boolean(task.completionDeliveredAt || job.completionDeliveredAt);
  }
}

/** Owns restart recovery state and re-enqueues each undelivered task independently. */
export class AgentCompletionRecoveryService extends Service {
  private recoveryPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly source: PendingCompletionSource,
    private readonly inbox: AgentCompletionInboxService,
    private readonly deliveryPolicy = new CompletionDeliveryPolicy(),
  ) {
    super();
  }

  recover(): Promise<void> {
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.recoverPending().finally(() => {
        this.recoveryPromise = null;
      });
    }
    return this.recoveryPromise;
  }

  dispose(): void {
    this.inFlight.clear();
    this.recoveryPromise = null;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  private async recoverPending(): Promise<void> {
    const jobs = this.source.getPendingCompletions
      ? await this.source.getPendingCompletions()
      : await this.source.pendingCompletions?.() ?? [];
    for (const job of jobs) await this.recoverJob(job);
  }

  private async recoverJob(job: AgentJob): Promise<void> {
    if (job.status === 'stopped' || this.inFlight.has(job.jobId) || !job.parentChannel || !job.parentThreadId) return;
    this.inFlight.add(job.jobId);
    try {
      job.tasks.forEach((task, taskIndex) => {
        const result = task.completion ?? job.results[taskIndex];
        if (result && !this.deliveryPolicy.isDelivered(job, task)) {
          this.inbox.enqueue(job.parentChannel!, job.parentThreadId!, {
            jobId: job.jobId,
            taskIndex,
            results: [result],
          });
        }
      });
    } catch (error) {
      console.warn(`[AgentCompletionRecovery] delivery failed for ${ job.jobId }; will retry:`, error);
    } finally {
      this.inFlight.delete(job.jobId);
    }
  }
}
