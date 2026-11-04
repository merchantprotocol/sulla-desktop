// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentJob } from './jobRegistry';

export interface JobRetentionRepository {
  hasQueuedOrRunningChildren(job: AgentJob): Promise<boolean>;
  deleteJob(jobId: string): Promise<void>;
}

export interface JobRetentionClock {
  now(): number;
}

/**
 * Authorizes explicit job pruning. The default retention period is seven days;
 * callers may inject another duration and clock for a deliberate retention run.
 * Reads must never invoke this policy or delete a job.
 */
export class JobRetentionPolicy {
  static readonly DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

  constructor(
    private readonly clock: JobRetentionClock,
    private readonly repository: JobRetentionRepository,
    private readonly retentionMs = JobRetentionPolicy.DEFAULT_RETENTION_MS,
  ) {}

  async mayPrune(job: AgentJob): Promise<boolean> {
    if (!['completed', 'failed', 'stopped'].includes(job.status) || !job.finishedAt) return false;
    if ((this.clock.now() - job.finishedAt) < this.retentionMs) return false;
    if (await this.repository.hasQueuedOrRunningChildren(job)) return false;
    if (this.hasOpenContract(job)) return false;

    return true;
  }

  async prune(job: AgentJob): Promise<boolean> {
    if (!await this.mayPrune(job)) return false;
    await this.repository.deleteJob(job.jobId);

    return true;
  }

  private hasOpenContract(job: AgentJob): boolean {
    if (job.status === 'stopped' || job.status === 'failed') return false;
    return job.tasks.some(task => !task.returnedAt && task.status !== 'stopped' && task.status !== 'error');
  }
}
