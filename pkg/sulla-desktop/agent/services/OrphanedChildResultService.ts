// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobResult, OrphanedChildNotice } from '../tools/agents/jobRegistry';

export interface OrphanedChildJobStore {
  findTaskByThread(threadId: string): Promise<{ job: AgentJob; taskIndex: number } | undefined>;
  appendOrphanNotice(jobId: string, notice: OrphanedChildNotice): Promise<boolean>;
}

export interface OrphanedChildCapture {
  notice: OrphanedChildNotice;
  route?: { channel: string; threadId: string };
  duplicate?: boolean;
}

/** Redirects late child results without ever reopening their finished manager. */
export class OrphanedChildResultService {
  constructor(private readonly jobs: OrphanedChildJobStore) {}

  async capture(child: AgentJob, results: AgentJobResult[], taskIndex: number): Promise<OrphanedChildCapture | null> {
    if (!child.parentThreadId) return null;
    const ownership = await this.jobs.findTaskByThread(child.parentThreadId);
    const owner = ownership?.job;
    if (!owner || (owner.status !== 'completed' && owner.status !== 'failed' && owner.status !== 'stopped')) return null;

    const notice: OrphanedChildNotice = {
      childJobId: child.jobId,
      taskIndex,
      managerThreadId: child.parentThreadId,
      managerStatus: owner.status,
      results,
      recordedAt: Date.now(),
    };
    const recorded = await this.jobs.appendOrphanNotice(owner.jobId, notice);

    return {
      notice,
      ...(!recorded ? { duplicate: true } : {}),
      ...(owner.parentThreadId ? {
        route: { channel: owner.parentChannel || 'sulla-desktop', threadId: owner.parentThreadId },
      } : {}),
    };
  }
}
