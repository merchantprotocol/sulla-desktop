// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../tools/agents/jobRegistry';

export interface InterruptedJobRepository {
  claimInterruptedJobs(maxResumes?: number): Promise<{ resumable: AgentJob[]; exhausted: AgentJob[] }>;
}

/** Re-enters durable hidden-agent threads after a runtime restart, with a bounded retry count. */
export class InterruptedAgentRecoveryService {
  constructor(
    private readonly jobs: InterruptedJobRepository,
    private readonly resume: (job: AgentJob, taskIndex: number) => Promise<void>,
    private readonly failed: (job: AgentJob, reason: string) => void,
    private readonly maxResumes = 2,
    private readonly launchesPaused: () => Promise<boolean> = async() => (await import('./AgentLaunchPauseService')).agentLaunchPauseService.isPaused(),
  ) {}

  async recover(): Promise<void> {
    if (await this.launchesPaused()) return;
    const claimed = await this.jobs.claimInterruptedJobs(this.maxResumes);
    for (const job of claimed.exhausted) this.failed(job, job.error ?? 'runtime restart recovery limit exceeded');
    for (const job of claimed.resumable) {
      for (let index = 0; index < job.tasks.length; index++) {
        const task = job.tasks[index];
        if (task.status !== 'running' || !task.threadId || task.returnedAt) continue;
        await this.resume(job, index);
      }
    }
  }
}
