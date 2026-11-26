// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../tools/agents/jobRegistry';
import { AbortSignalBridge } from '../app/Services/AbortSignalBridge';

export interface RecoveredAgentTaskJobs {
  getJob(jobId: string): Promise<AgentJob | undefined>;
  ensureTaskAbortSignal(jobId: string, taskIndex: number): AbortSignal;
}

export type RecoveredAgentTaskDispatch = (job: AgentJob, taskIndex: number, controller: AbortController) => Promise<unknown>;

/** Revalidates a claimed snapshot and binds recovery to the ordinary stop signal. */
export class RecoveredAgentTaskDispatcher {
  constructor(private readonly jobs: RecoveredAgentTaskJobs, private readonly dispatch: RecoveredAgentTaskDispatch) {}

  async dispatchIfRunning(claimedJob: AgentJob, taskIndex: number, waitUntilReady: () => Promise<void>): Promise<boolean> {
    await waitUntilReady();
    const signal = this.jobs.ensureTaskAbortSignal(claimedJob.jobId, taskIndex);
    const current = await this.jobs.getJob(claimedJob.jobId);
    if (current?.status !== 'running' || current.tasks[taskIndex]?.status !== 'running') return false;

    if (signal.aborted) return false;
    const controller = new AbortController();
    const bridge = new AbortSignalBridge(signal, controller);
    try { await this.dispatch(current, taskIndex, controller) }
    finally { bridge.dispose() }
    return true;
  }
}
