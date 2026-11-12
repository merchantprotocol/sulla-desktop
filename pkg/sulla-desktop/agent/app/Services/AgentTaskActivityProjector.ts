// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import { LiveTaskStatusProjector } from './LiveTaskStatusProjector';
import { UnresolvedBlockerPolicy } from './UnresolvedBlockerPolicy';

export interface AgentTaskActivityReader { lastActivityAt(key: string): number | undefined }
export interface AgentTaskActivityCheckin { createdAt: number; blockers?: string[] }
export interface AgentTaskActivityProjection { lastActivityAt: number; state: string }

/** One task-scoped activity and presentation-state policy shared by every fleet surface. */
export class AgentTaskActivityProjector {
  constructor(
    private readonly activity: AgentTaskActivityReader,
    private readonly now: () => number = Date.now,
    private readonly quietAfterMs = 5 * 60_000,
    private readonly liveness: LiveTaskStatusProjector = new LiveTaskStatusProjector(),
    private readonly blockers: UnresolvedBlockerPolicy = new UnresolvedBlockerPolicy(liveness),
  ) {}

  /** Presentation states that still represent work in progress. Everything else is terminal. */
  static isOpen(state: string): boolean {
    return ['queued', 'working', 'quiet', 'parked', 'blocked'].includes(state);
  }

  /** `answeredAt` is the latest orchestrator-message delivery to this task, used to resolve its blocker. */
  project(job: AgentJob, task: AgentJobTask, taskIndex: number, checkin?: AgentTaskActivityCheckin | null, answeredAt?: number | null): AgentTaskActivityProjection {
    const startedAt = task.startedAt ?? job.createdAt;
    const lastActivityAt = Math.max(
      startedAt,
      checkin?.createdAt ?? 0,
      this.activity.lastActivityAt(`${ job.jobId }#${ taskIndex }`) ?? 0,
      task.finishedAt ?? 0,
      task.returnedAt ?? 0,
    );
    return { lastActivityAt, state: this.state(job, task, checkin ?? null, lastActivityAt, answeredAt ?? null) };
  }

  /** Derived from the task's own lifecycle only. The job's status is never inherited. */
  private state(job: AgentJob, task: AgentJobTask, checkin: AgentTaskActivityCheckin | null, lastActivityAt: number, answeredAt: number | null): string {
    if (task.status === 'stopped') return 'stopped';
    // A stale task error can outlive a successfully delivered completion result.
    // Match AgentStateService's derived job status while keeping genuine errors terminal.
    if (task.status === 'error' && task.completion?.status === 'completed') return 'done';
    if (task.status === 'error') return job.error?.startsWith('lost:') ? 'lost' : 'failed';
    if (task.status === 'lost') return 'lost';
    if (task.status === 'completed') return 'done';
    if (!this.liveness.isLive(task)) return 'done';
    const unresolved = this.blockers.unresolvedCount({ task, checkin, answeredAt, startedAt: task.startedAt ?? job.createdAt });
    if (unresolved > 0) return 'blocked';
    if (task.status === 'parked' || (task.wakeAt !== undefined && task.wakeAt > this.now())) return 'parked';
    if (task.status === 'queued') return 'queued';
    if (task.status === 'running' && this.now() - lastActivityAt >= this.quietAfterMs) return 'quiet';
    return 'working';
  }
}
