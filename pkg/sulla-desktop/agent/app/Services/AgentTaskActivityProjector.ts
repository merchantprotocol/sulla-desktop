// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentTaskActivityReader { lastActivityAt(key: string): number | undefined }
export interface AgentTaskActivityCheckin { createdAt: number; blockers?: string[] }
export interface AgentTaskActivityProjection { lastActivityAt: number; state: string }

/** One task-scoped activity and presentation-state policy shared by every fleet surface. */
export class AgentTaskActivityProjector {
  constructor(
    private readonly activity: AgentTaskActivityReader,
    private readonly now: () => number = Date.now,
    private readonly quietAfterMs = 5 * 60_000,
  ) {}

  project(job: AgentJob, task: AgentJobTask, taskIndex: number, checkin?: AgentTaskActivityCheckin | null): AgentTaskActivityProjection {
    const startedAt = task.startedAt ?? job.createdAt;
    const lastActivityAt = Math.max(
      startedAt,
      checkin?.createdAt ?? 0,
      this.activity.lastActivityAt(`${ job.jobId }#${ taskIndex }`) ?? 0,
      task.finishedAt ?? 0,
      task.returnedAt ?? 0,
    );
    return { lastActivityAt, state: this.state(job, task, checkin, lastActivityAt) };
  }

  private state(job: AgentJob, task: AgentJobTask, checkin: AgentTaskActivityCheckin | null | undefined, lastActivityAt: number): string {
    if (job.status === 'stopped' || task.status === 'stopped') return 'stopped';
    if (job.status === 'failed' || task.status === 'error') return job.error?.startsWith('lost:') ? 'lost' : 'failed';
    if (task.status === 'completed') return 'done';
    if (task.status === 'parked' || (task.wakeAt !== undefined && task.wakeAt > this.now())) return 'parked';
    if (task.status === 'queued') return 'queued';
    if (checkin?.blockers?.length || task.status === 'blocked') return 'blocked';
    if (task.status === 'running' && this.now() - lastActivityAt >= this.quietAfterMs) return 'quiet';
    return task.status === 'running' ? 'working' : task.status;
  }
}
