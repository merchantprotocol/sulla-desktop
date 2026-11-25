// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentTaskActivityProjector } from './AgentTaskActivityProjector';
import { resultTracking } from '../../../shared/agentResults/AgentResultCard';
import { savedWorkerModelStatus } from '../../languagemodels/workerModelBindings';
import { AgentModelStatusRegistry } from '../../services/AgentModelStatusRegistry';
import { describeHungTool } from '../../services/RunLivenessClock';

import type { AgentRuntimeLiveness } from './AgentRuntimeLiveness';
import type { AgentStateService } from './AgentStateService';
import type { AgentStateRow, AgentStateSnapshot, AgentRowState } from '../../../shared/agentState/AgentStateSnapshot';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

/** Derived presentation state. Durable task status remains the lifecycle contract. */
export type AgentViewStatus = AgentRowState;

export interface AgentTaskCheckin { createdAt: number; summary: string; blockers: string[]; }
export interface AgentStateTelemetry {
  latest(jobId: string, taskIndex: number): Promise<AgentTaskCheckin | null>;
  latestForJobs?(jobIds: string[]): Promise<Record<string, Record<number, AgentTaskCheckin | null>>>;
  /** Latest time Sulla's message (its answer) was delivered to each task; a later answer clears a blocker. */
  answeredForJobs?(jobIds: string[]): Promise<Record<string, Record<number, number | null>>>;
}
export interface AgentLaunchCapabilityReader {
  launchableAgentIds(agentIds: readonly string[]): Promise<ReadonlySet<string>>;
}
export interface AgentProjectionConfig { quietAfterMs: number; terminalTtlMs: number; }
const DEFAULT_CONFIG: AgentProjectionConfig = { quietAfterMs: 5 * 60_000, terminalTtlMs: 2 * 60_000 };

/** Pure projection of the authoritative job graph into the renderer contract. */
export class AgentStateProjector {
  private readonly config: AgentProjectionConfig;
  private inFlight?: Promise<AgentStateSnapshot>;
  constructor(private readonly states: AgentStateService, private readonly telemetry: AgentStateTelemetry,
    private readonly clock: () => number = Date.now, config: Partial<AgentProjectionConfig> = {},
    private readonly activity = new AgentTaskActivityProjector({ lastActivityAt: () => undefined }, clock, config.quietAfterMs ?? DEFAULT_CONFIG.quietAfterMs),
    private readonly runtime?: Pick<AgentRuntimeLiveness, 'alive'>,
    /** When this process started watching: activity before it (a restart) is unknown, not silence. */
    private readonly observedSince: number = clock(),
    private readonly launchCapabilities?: AgentLaunchCapabilityReader) { this.config = { ...DEFAULT_CONFIG, ...config }; }

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
    const jobIds = [...new Set(jobs.map(job => job.jobId))];
    const agentIds = [...new Set(jobs.flatMap(job => job.tasks.map(task => task.agentId).filter(Boolean)))];
    const [latestByJob, answeredByJob] = await Promise.all([
      this.telemetry.latestForJobs ? this.telemetry.latestForJobs(jobIds) : undefined,
      this.telemetry.answeredForJobs ? this.telemetry.answeredForJobs(jobIds).catch(() => undefined) : undefined,
    ]);
    const launchableAgentIds = this.launchCapabilities
      ? await this.launchCapabilities.launchableAgentIds(agentIds).catch(() => new Set<string>())
      : new Set<string>();
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
      const { lastActivityAt, state, runtimeAlive } = this.taskActivity(job, task, taskIndex, checkin, answeredByJob?.[job.jobId]?.[taskIndex] ?? null, now);
      const stoppedBy = task.stoppedBy ?? job.stoppedBy;
      const stopReason = task.stopReason ?? job.stopReason;
      const waitingOnChildren = task.threadId ? waitingByThread.get(task.threadId) ?? 0 : 0;
      rows.push({ key: `${ job.jobId }:${ taskIndex }`, jobId: job.jobId, taskIndex,
        parentJobId: job.parentJobId ?? null, parentTaskIndex: job.parentTaskIndex ?? null,
        rootThreadId: lineage.rootThreadId, threadId: task.threadId ?? null,
        depth: lineage.depth, agentId: task.agentId || null,
        canLaunchAgents: launchableAgentIds.has(task.agentId), label: task.label || task.agentId,
        taskId:             task.taskId,
        modelStatus:        AgentModelStatusRegistry.get(task.threadId) ?? savedWorkerModelStatus(task.workerModelRoute) ?? (task.model ? { model: task.model, provider: task.provider, effort: task.effort ?? null, source: 'requested' } : undefined),
        visibility: task.visibility === 'tab' || job.visibility === 'tab' ? 'tab' : 'hidden', state,
        stateReason: this.reason(state, job, task, checkin),
        ...resultTracking(task),
        // Why a parked task is waiting and when it checks again, so the window can say "waiting on GitHub checks · 12:12".
        waitReason: state === 'parked' ? task.waitReason ?? null : null,
        wakeAt: state === 'parked' && task.wakeAt !== undefined && task.wakeAt > now ? this.iso(task.wakeAt) : null,
        stoppedBy, stopReason, killedByHuman: stoppedBy === 'human', waitingOnChildren,
        startedAt: this.iso(task.startedAt ?? job.createdAt), endedAt: this.iso(endedAt),
        lastActivityAt: new Date(lastActivityAt).toISOString(),
        lastCheckinAt: this.iso(checkin?.createdAt), lastCheckinSummary: checkin?.summary ?? null,
        toolInFlight: this.toolView(state, this.activity.toolInFlight(job.jobId, taskIndex)),
        runtimeAlive,
        canMessage: live, canStop: live, canOpen: Boolean(task.threadId) });
    }
    return { version, generatedAt: new Date(now).toISOString(), rows };
  }

  taskActivity(job: AgentJob, task: AgentJobTask, taskIndex: number, checkin: AgentTaskCheckin | null, answeredAt: number | null, now = this.clock()) {
    const { state: projected, lastActivityAt } = this.activity.project(job, task, taskIndex, checkin, answeredAt);
    // The same boot grace and probe freshness apply to the UI and parent notices.
    const state = (projected === 'quiet' && now - Math.max(lastActivityAt, this.observedSince) < this.config.quietAfterMs
      ? 'working' : projected) as AgentViewStatus;
    const tool = this.activity.toolInFlight(job.jobId, taskIndex);
    return { state, lastActivityAt, runtimeAlive: state === 'quiet' ? this.runtime?.alive(task.threadId) ?? null : null,
      // Only a tool past the ceiling can sit under a quiet task: name it so alerts say "tool still running", not "dead".
      hungTool: state === 'quiet' && tool ? describeHungTool(tool, now) : null };
  }

  private reason(state: AgentViewStatus, job: AgentJob, task: AgentJobTask, checkin: AgentTaskCheckin | null): string | null {
    if (state === 'blocked') return checkin?.blockers.join('; ') || task.summary || 'Blocked';
    if (state === 'quiet') return 'No recent activity (no output, tool calls or check-ins)';
    if (state === 'parked' && task.wakeAt !== undefined && task.wakeAt > this.clock()) return 'scheduled wake-up';
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

  private toolView(state: AgentViewStatus, tool?: { name: string; startedAt: number }): AgentStateRow['toolInFlight'] {
    return tool && (state === 'working' || state === 'quiet') ? { name: tool.name, since: new Date(tool.startedAt).toISOString() } : null;
  }

  private iso(value?: number | null): string | null { return value ? new Date(value).toISOString() : null; }
}
