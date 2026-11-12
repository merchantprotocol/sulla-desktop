// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentStateRow, AgentStateSnapshot, AgentRowState } from '../../../shared/agentState/AgentStateSnapshot';

/** Derived presentation state. Durable task status remains the lifecycle contract. */
export type AgentViewStatus = AgentRowState;
import type { AgentStateService } from './AgentStateService';
import { AgentTaskActivityProjector } from './AgentTaskActivityProjector';

export interface AgentTaskCheckin { createdAt: number; summary: string; blockers: string[]; }
export interface AgentStateTelemetry {
  latest(jobId: string, taskIndex: number): Promise<AgentTaskCheckin | null>;
  latestForJobs?(jobIds: string[]): Promise<Record<string, Record<number, AgentTaskCheckin | null>>>;
}
export interface AgentProjectionConfig { quietAfterMs: number; terminalTtlMs: number; }
const DEFAULT_CONFIG: AgentProjectionConfig = { quietAfterMs: 5 * 60_000, terminalTtlMs: 2 * 60_000 };

/** Pure projection of the authoritative job graph into the renderer contract. */
export class AgentStateProjector {
  private readonly config: AgentProjectionConfig;
  private inFlight?: Promise<AgentStateSnapshot>;
  constructor(private readonly states: AgentStateService, private readonly telemetry: AgentStateTelemetry,
    private readonly clock: () => number = Date.now, config: Partial<AgentProjectionConfig> = {},
    private readonly activity = new AgentTaskActivityProjector({ lastActivityAt: () => undefined }, clock, config.quietAfterMs ?? DEFAULT_CONFIG.quietAfterMs)) { this.config = { ...DEFAULT_CONFIG, ...config }; }

  snapshot(): Promise<AgentStateSnapshot> {
    if (this.inFlight) return this.inFlight;
    const pending = this.buildSnapshot().finally(() => {
      if (this.inFlight === pending) this.inFlight = undefined;
    });
    this.inFlight = pending;
    return pending;
  }

  private async buildSnapshot(): Promise<AgentStateSnapshot> {
    // Bounded read that never waits on container inventory; includes ancestors so root threads resolve.
    const jobs = await this.states.jobsForProjection(this.config.terminalTtlMs * 5);
    // A change while telemetry loads must retain its own later version so the
    // renderer can accept the following snapshot instead of discarding it.
    const version = this.states.version;
    const now = this.clock();
    const latestByJob = this.telemetry.latestForJobs
      ? await this.telemetry.latestForJobs([...new Set(jobs.map(job => job.jobId))])
      : undefined;
    const jobById = new Map(jobs.map(job => [job.jobId, job]));
    const taskByKey = new Map(jobs.flatMap(job => job.tasks.map((task, taskIndex) => [`${ job.jobId }:${ taskIndex }`, task] as const)));
    const waitingByThread = new Map<string, number>();
    const ordered = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
    for (const job of ordered) {
      if (job.parentThreadId && ['running', 'parked'].includes(job.status)) {
        waitingByThread.set(job.parentThreadId, (waitingByThread.get(job.parentThreadId) ?? 0) + 1);
      }
    }
    const rows: AgentStateRow[] = [];
    for (const job of ordered) for (const [taskIndex, task] of job.tasks.entries()) {
      const endedAt = task.finishedAt ?? job.finishedAt;
      if (endedAt && now - endedAt > this.config.terminalTtlMs) continue;
      const lineage = this.lineage(job, jobById, taskByKey);
      const checkin = latestByJob
        ? latestByJob[job.jobId]?.[taskIndex] ?? null
        : await this.telemetry.latest(job.jobId, taskIndex);
      const live = this.states.isLive(job, task);
      const activity = this.activity.project(job, task, taskIndex, checkin);
      const state = activity.state as AgentViewStatus;
      const stoppedBy = task.stoppedBy ?? job.stoppedBy;
      const stopReason = task.stopReason ?? job.stopReason;
      const waitingOnChildren = task.threadId ? waitingByThread.get(task.threadId) ?? 0 : 0;
      rows.push({ key: `${ job.jobId }:${ taskIndex }`, jobId: job.jobId, taskIndex,
        parentJobId: job.parentJobId ?? null, parentTaskIndex: job.parentTaskIndex ?? null,
        rootThreadId: lineage.rootThreadId, threadId: task.threadId ?? null,
        depth: lineage.depth, agentId: task.agentId || null, label: task.label || task.agentId,
        visibility: task.visibility === 'tab' || job.visibility === 'tab' ? 'tab' : 'hidden', state,
        stateReason: this.reason(state, job, task, checkin), stoppedBy, stopReason, killedByHuman: stoppedBy === 'human', waitingOnChildren,
        startedAt: this.iso(task.startedAt ?? job.createdAt), endedAt: this.iso(endedAt),
        lastActivityAt: new Date(activity.lastActivityAt).toISOString(),
        lastCheckinAt: this.iso(checkin?.createdAt), lastCheckinSummary: checkin?.summary ?? null,
        canMessage: live, canStop: live, canOpen: Boolean(task.threadId) });
    }
    return { version, generatedAt: new Date(now).toISOString(), rows };
  }

  private reason(state: AgentViewStatus, job: AgentJob, task: AgentJobTask, checkin: AgentTaskCheckin | null): string | null {
    if (state === 'blocked') return checkin?.blockers.join('; ') || task.summary || 'Blocked';
    if (state === 'quiet') return 'No recent check-in';
    if (['failed', 'lost', 'stopped'].includes(state)) return job.error || task.summary || state;
    return null;
  }

  /** Resolve persisted parent task keys; malformed cycles become visible roots instead of looping. */
  private lineage(job: AgentJob, jobs: ReadonlyMap<string, AgentJob>, tasks: ReadonlyMap<string, AgentJobTask>): { rootThreadId: string | null; depth: number } {
    let current = job;
    let rootThreadId = job.parentThreadId ?? null;
    let depth = 0;
    const visited = new Set<string>([job.jobId]);
    while (current.parentJobId && current.parentTaskIndex !== null && current.parentTaskIndex !== undefined) {
      if (!tasks.has(`${ current.parentJobId }:${ current.parentTaskIndex }`)) break;
      const parent = jobs.get(current.parentJobId);
      if (!parent || visited.has(parent.jobId)) break;
      visited.add(parent.jobId);
      current = parent;
      rootThreadId = current.parentThreadId ?? rootThreadId;
      depth += 1;
    }
    return { rootThreadId, depth };
  }

  private iso(value?: number | null): string | null { return value ? new Date(value).toISOString() : null; }
}
