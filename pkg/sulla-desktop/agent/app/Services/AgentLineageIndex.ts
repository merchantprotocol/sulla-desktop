// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../../tools/agents/jobRegistry';

export interface AgentLineage {
  parentJobId: string | null;
  parentTaskIndex: number | null;
  rootThreadId: string | null;
}

interface TaskOwner { job: AgentJob; taskIndex: number }

/** Builds and queries the persisted parent-thread/task-thread relationship for one snapshot. */
export class AgentLineageIndex {
  private readonly taskByThreadId = new Map<string, TaskOwner>();
  private readonly lineageByJobId = new Map<string, AgentLineage>();

  constructor(private readonly jobs: AgentJob[]) {
    for (const job of [...jobs].sort((left, right) => left.createdAt - right.createdAt)) {
      job.tasks.forEach((task, taskIndex) => {
        if (task.threadId && !this.taskByThreadId.has(task.threadId)) this.taskByThreadId.set(task.threadId, { job, taskIndex });
      });
    }
  }

  lineage(job: AgentJob): AgentLineage {
    const cached = this.lineageByJobId.get(job.jobId);
    if (cached) return cached;
    const immediate = job.parentThreadId ? this.taskByThreadId.get(job.parentThreadId) : undefined;
    const visited = new Set<string>([job.jobId]);
    let cursor = job;
    let rootThreadId = job.parentThreadId ?? null;
    while (cursor.parentThreadId) {
      rootThreadId = cursor.parentThreadId;
      const owner = this.taskByThreadId.get(cursor.parentThreadId);
      if (!owner || visited.has(owner.job.jobId)) break;
      visited.add(owner.job.jobId);
      cursor = owner.job;
    }
    const lineage = {
      parentJobId: immediate?.job.jobId ?? null,
      parentTaskIndex: immediate?.taskIndex ?? null,
      rootThreadId,
    };
    this.lineageByJobId.set(job.jobId, lineage);
    return lineage;
  }

  descendants(parentThreadId: string): AgentJob[] {
    const includedThreads = new Set([parentThreadId]);
    const includedJobs = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const job of this.jobs) {
        if (includedJobs.has(job.jobId) || !job.parentThreadId || !includedThreads.has(job.parentThreadId)) continue;
        includedJobs.add(job.jobId);
        for (const task of job.tasks) if (task.threadId) includedThreads.add(task.threadId);
        changed = true;
      }
    }
    return this.jobs.filter(job => includedJobs.has(job.jobId)).sort((left, right) => left.createdAt - right.createdAt);
  }
}
