// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../tools/agents/jobRegistry';

export interface InterruptedJobRepository {
  claimInterruptedJobs(maxResumes?: number): Promise<{ resumable: AgentJob[]; exhausted: AgentJob[] }>;
  recoveryCandidates?(): Promise<AgentJob[]>;
  claimInterruptedJob?(id: string, maxResumes: number): Promise<{ resumable: AgentJob[]; exhausted: AgentJob[] }>;
}

/** Re-enters durable hidden-agent threads after a runtime restart, with a bounded retry count. */
export class InterruptedAgentRecoveryService {
  constructor(
    private readonly jobs: InterruptedJobRepository,
    private readonly resume: (job: AgentJob, taskIndex: number) => Promise<void>,
    private readonly failed: (job: AgentJob, reason: string) => void,
    private readonly maxResumes = 2,
    private readonly launchesPaused: () => Promise<boolean> = async() => (await import('./AgentLaunchPauseService')).agentLaunchPauseService.isPaused(),
    private readonly mayResumeTask: (job: AgentJob, index: number) => Promise<boolean> = () => Promise.resolve(true),
  ) {}

  async recover(): Promise<void> {
    if (await this.launchesPaused()) return;
    if (this.jobs.recoveryCandidates && this.jobs.claimInterruptedJob) {
      for (const candidate of await this.jobs.recoveryCandidates()) {
        if (await this.launchesPaused()) return;
        await this.resumeClaimed(await this.jobs.claimInterruptedJob(candidate.jobId, this.maxResumes));
      }
      return;
    }
    await this.resumeClaimed(await this.jobs.claimInterruptedJobs(this.maxResumes));
  }

  private async resumeClaimed(claimed: { resumable: AgentJob[]; exhausted: AgentJob[] }): Promise<void> {
    for (const job of claimed.exhausted) this.failed(job, job.error ?? 'runtime restart recovery limit exceeded');
    for (const job of claimed.resumable) {
      for (let index = 0; index < job.tasks.length; index++) {
        const task = job.tasks[index];
        if (task.status !== 'running' || !task.threadId || task.returnedAt) continue;
        if (await this.mayResumeTask(job, index)) await this.resume(job, index);
      }
    }
  }
}
