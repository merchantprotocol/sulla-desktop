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

export interface CompletionRecoveryTimer {
  every(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clear(timer: ReturnType<typeof setInterval>): void;
}

export class SystemCompletionRecoveryTimer implements CompletionRecoveryTimer {
  every(callback: () => void, intervalMs: number): ReturnType<typeof setInterval> { return setInterval(callback, intervalMs); }
  clear(timer: ReturnType<typeof setInterval>): void { clearInterval(timer); }
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
    private readonly clock: () => number = Date.now,
    private readonly timer: CompletionRecoveryTimer = new SystemCompletionRecoveryTimer(),
  ) {
    super();
  }

  start(intervalMs = 120_000, minimumAgeMs = 120_000): void {
    if (this.sweepTimer) return;
    this.sweepAgeMs = minimumAgeMs;
    this.sweepTimer = this.timer.every(() => { void this.recover(this.sweepAgeMs).catch(error => console.warn('[AgentCompletionRecovery] sweep failed:', error)); }, intervalMs);
    (this.sweepTimer as any).unref?.();
  }

  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweepAgeMs = 0;

  /** Startup/explicit recovery is immediate; the background sweep supplies its age threshold. */
  recover(minimumAgeMs = 0): Promise<void> {
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.recoverPending(minimumAgeMs).finally(() => {
        this.recoveryPromise = null;
      });
    }
    return this.recoveryPromise;
  }

  dispose(): void {
    if (this.sweepTimer) this.timer.clear(this.sweepTimer);
    this.sweepTimer = undefined;
    this.inFlight.clear();
    this.recoveryPromise = null;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  private async recoverPending(minimumAgeMs: number): Promise<void> {
    const jobs = this.source.getPendingCompletions
      ? await this.source.getPendingCompletions()
      : await this.source.pendingCompletions?.() ?? [];
    for (const job of jobs) await this.recoverJob(job, minimumAgeMs);
  }

  private async recoverJob(job: AgentJob, minimumAgeMs: number): Promise<void> {
    if (job.status === 'stopped' || this.inFlight.has(job.jobId) || !job.parentChannel || !job.parentThreadId) return;
    this.inFlight.add(job.jobId);
    try {
      job.tasks.forEach((task, taskIndex) => {
        const result = task.completion ?? job.results[taskIndex];
        const returnedAt = task.returnedAt ?? task.finishedAt ?? job.finishedAt ?? job.createdAt;
        if (result && !this.deliveryPolicy.isDelivered(job, task) && this.clock() - returnedAt >= minimumAgeMs) {
          this.inbox.enqueue(job.parentChannel!, job.parentThreadId!, {
            jobId: job.jobId,
            taskIndex,
            results: [result],
            notice: task.completionFirstDeliveredAt
              ? `[re-delivery: first delivered at ${new Date(task.completionFirstDeliveredAt).toISOString()}] [job state: ${job.status}]\n\n${result.output}`
              : undefined,
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
