// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../tools/agents/jobRegistry';
import { hiddenAgentRuns } from './HiddenAgentRuns';

export interface HiddenWorkerGraphStore { get(threadId: string): { metadata: any } | undefined }
export interface ActiveAgentJobs { list(): Promise<AgentJob[]> }
export type HiddenWorkerResume = (job: AgentJob, taskIndex: number) => void;
export interface HiddenWorkerRunWaiter { waitForThread(threadId: string): Promise<void> }

/** Marks and aborts only a live hidden task so its durable running row can be resumed on wake. */
export class HiddenAgentRunInterrupter {
  constructor(private readonly graphs: HiddenWorkerGraphStore) {}

  interrupt(jobId: string, taskIndex: number, threadId: string): boolean {
    const metadata = this.graphs.get(threadId)?.metadata;
    if (metadata?.delegatedJobId !== jobId || metadata?.delegatedTaskIndex !== taskIndex || metadata.runtimeRunnerActive !== true) return false;
    metadata.runtimeInterrupted = true;
    metadata.options?.abort?.abort();
    return true;
  }
}

/** Snapshots running hidden tasks at suspend, interrupts their dead streams, then re-dispatches on wake. */
export class HiddenAgentWakeRecovery {
  private suspendedTasks?: Promise<Array<{ job: AgentJob; taskIndex: number; threadId: string }>>;

  constructor(
    private readonly jobs: ActiveAgentJobs,
    private readonly runs: HiddenAgentRunInterrupter,
    private readonly resumeTask: HiddenWorkerResume,
    private readonly runnerRuns: HiddenWorkerRunWaiter = hiddenAgentRuns,
  ) {}

  suspend(): void { this.suspendedTasks = this.captureInterruptedTasks(); }

  async resume(): Promise<void> {
    const suspended = this.suspendedTasks;
    this.suspendedTasks = undefined;
    if (!suspended) return;
    for (const { job, taskIndex, threadId } of await suspended) {
      await this.runnerRuns.waitForThread(threadId);
      this.resumeTask(job, taskIndex);
    }
  }

  private async captureInterruptedTasks(): Promise<Array<{ job: AgentJob; taskIndex: number; threadId: string }>> {
    const interrupted: Array<{ job: AgentJob; taskIndex: number; threadId: string }> = [];
    for (const job of await this.jobs.list()) {
      if (job.status !== 'running' || job.visibility === 'tab') continue;
      job.tasks.forEach((task, taskIndex) => {
        if (task.status === 'running' && !task.returnedAt && task.threadId && this.runs.interrupt(job.jobId, taskIndex, task.threadId)) {
          interrupted.push({ job, taskIndex, threadId: task.threadId });
        }
      });
    }
    return interrupted;
  }
}
