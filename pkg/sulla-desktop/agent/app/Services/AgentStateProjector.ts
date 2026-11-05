// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentStateRow, AgentStateSnapshot, AgentRowState } from '../../../shared/agentState/AgentStateSnapshot';
import type { AgentStateService } from './AgentStateService';

export interface AgentTaskCheckin { createdAt: number; summary: string; blockers: string[]; }
export interface AgentStateTelemetry { latest(jobId: string, taskIndex: number): Promise<AgentTaskCheckin | null>; }
export interface AgentProjectionConfig { quietAfterMs: number; terminalTtlMs: number; }
const DEFAULT_CONFIG: AgentProjectionConfig = { quietAfterMs: 5 * 60_000, terminalTtlMs: 2 * 60_000 };

/** Pure projection of the authoritative job graph into the renderer contract. */
export class AgentStateProjector {
  private readonly config: AgentProjectionConfig;
  constructor(private readonly states: AgentStateService, private readonly telemetry: AgentStateTelemetry,
    private readonly clock: () => number = Date.now, config: Partial<AgentProjectionConfig> = {}) { this.config = { ...DEFAULT_CONFIG, ...config }; }

  async snapshot(): Promise<AgentStateSnapshot> {
    const jobs = await this.states.jobs();
    const now = this.clock();
    const taskOwner = new Map<string, { jobId: string; taskIndex: number; rootThreadId: string | null; depth: number }>();
    const ordered = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
    for (const job of ordered) for (const [taskIndex, task] of job.tasks.entries()) if (task.threadId) {
      const parent = job.parentThreadId ? taskOwner.get(job.parentThreadId) : undefined;
      taskOwner.set(task.threadId, { jobId: job.jobId, taskIndex, rootThreadId: parent?.rootThreadId ?? job.parentThreadId ?? null, depth: (parent?.depth ?? -1) + 1 });
    }
    const rows: AgentStateRow[] = [];
    for (const job of ordered) for (const [taskIndex, task] of job.tasks.entries()) {
      const endedAt = task.finishedAt ?? job.finishedAt;
      if (endedAt && now - endedAt > this.config.terminalTtlMs) continue;
      const parent = job.parentThreadId ? taskOwner.get(job.parentThreadId) : undefined;
      const checkin = await this.telemetry.latest(job.jobId, taskIndex);
      const live = this.states.isLive(job, task);
      const state = this.resolveState(job, task, checkin, now);
      const waitingOnChildren = task.threadId ? ordered.filter(candidate => candidate.parentThreadId === task.threadId && ['running', 'parked'].includes(candidate.status)).length : 0;
      rows.push({ key: `${ job.jobId }:${ taskIndex }`, jobId: job.jobId, taskIndex,
        parentJobId: parent?.jobId ?? null, parentTaskIndex: parent?.taskIndex ?? null,
        rootThreadId: parent?.rootThreadId ?? job.parentThreadId ?? null, threadId: task.threadId ?? null,
        depth: parent ? parent.depth + 1 : 0, agentId: task.agentId || null, label: task.label || task.agentId,
        visibility: task.visibility === 'tab' || job.visibility === 'tab' ? 'tab' : 'hidden', state,
        stateReason: this.reason(state, job, task, checkin), waitingOnChildren,
        startedAt: this.iso(task.startedAt ?? job.createdAt), endedAt: this.iso(endedAt),
        lastCheckinAt: this.iso(checkin?.createdAt), lastCheckinSummary: checkin?.summary ?? null,
        canMessage: live, canStop: live, canOpen: Boolean(task.threadId) });
    }
    return { version: this.states.version, generatedAt: new Date(now).toISOString(), rows };
  }

  private resolveState(job: AgentJob, task: AgentJobTask, checkin: AgentTaskCheckin | null, now: number): AgentRowState {
    if (job.status === 'stopped' || task.status === 'stopped') return 'stopped';
    if (task.status === 'lost') return 'lost';
    if (job.status === 'failed' || task.status === 'error') return job.error?.startsWith('lost:') ? 'lost' : 'failed';
    if (task.status === 'completed') return 'done';
    if (task.status === 'parked') return 'parked';
    if (task.status === 'queued') return 'queued';
    if (checkin?.blockers?.length || task.status === 'blocked') return 'blocked';
    const lastActivityAt = checkin?.createdAt ?? task.startedAt ?? job.createdAt;
    if (now - lastActivityAt > this.config.quietAfterMs) return 'quiet';
    return 'working';
  }
  private reason(state: AgentRowState, job: AgentJob, task: AgentJobTask, checkin: AgentTaskCheckin | null): string | null {
    if (state === 'blocked') return checkin?.blockers.join('; ') || task.summary || 'Blocked';
    if (state === 'quiet') return 'No recent check-in';
    if (['failed', 'lost', 'stopped'].includes(state)) return job.error || task.summary || state;
    return null;
  }
  private iso(value?: number | null): string | null { return value ? new Date(value).toISOString() : null; }
}
