// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobRepository } from '../app/Repositories/AgentJobRepository';
import type { AgentJob, AgentJobResult, OrphanedChildNotice } from '../tools/agents/jobRegistry';

export interface OrphanedChildCapture {
  notice: OrphanedChildNotice;
  route?: { channel: string; threadId: string };
}

/** Redirects late child results without ever reopening their finished manager. */
export class OrphanedChildResultService {
  constructor(private readonly jobs: AgentJobRepository) {}

  async capture(child: AgentJob, results: AgentJobResult[], taskIndex: number): Promise<OrphanedChildCapture | null> {
    if (!child.parentThreadId) return null;
    const owner = await this.jobs.findByTaskThread(child.parentThreadId);
    if (!owner || !['completed', 'failed', 'stopped'].includes(owner.status)) return null;

    const notice: OrphanedChildNotice = {
      childJobId: child.jobId,
      taskIndex,
      managerThreadId: child.parentThreadId,
      managerStatus: owner.status,
      results,
      recordedAt: Date.now(),
    };
    await this.jobs.appendOrphanNotice(owner.jobId, notice);

    return {
      notice,
      ...(owner.parentThreadId ? {
        route: { channel: owner.parentChannel || 'sulla-desktop', threadId: owner.parentThreadId },
      } : {}),
    };
  }
}
