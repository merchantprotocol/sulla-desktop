// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentJobCheckin, AgentJobTaskTelemetry } from '../../database/models/AgentJobMessagingModel';
import type { ConversationTitleRepository } from '../Repositories/ConversationTitleRepository';
import type { AgentStateService } from './AgentStateService';
import { AgentLineageIndex } from './AgentLineageIndex';
import type { FleetJobView, FleetTaskView } from './AgentFleetTypes';

export interface AgentFleetTelemetryReader {
  telemetryForJob(jobId: string): Promise<Record<number, AgentJobTaskTelemetry>>;
  latestTelemetryForJobs(jobIds: string[]): Promise<Record<string, Record<number, AgentJobTaskTelemetry>>>;
}

export interface AgentFleetRequest {
  scope: 'mine' | 'all';
  callerThreadId?: string;
  limit?: number;
  includeFinished?: boolean;
}

type FleetObject = Record<string, unknown>;

/** Authoritative, lineage-enriched fleet read model consumed by agent supervision tools. */
export class AgentFleetProjectionService {
  constructor(
    private readonly states: AgentStateService,
    private readonly telemetry: AgentFleetTelemetryReader,
    private readonly titles: ConversationTitleRepository,
    private readonly now: () => number = Date.now,
    private readonly stranded?: { deliveredForManagers(): Promise<Map<string, { stateKey: string; reason: string }>> },
  ) {}

  async list(request: AgentFleetRequest): Promise<FleetJobView[]> {
    const all = await this.states.jobs();
    const index = new AgentLineageIndex(all);
    const scoped = request.scope === 'mine'
      ? index.descendants(this.requiredCaller(request.callerThreadId))
      : all;
    const selected = this.bound(scoped, request.limit, request.includeFinished);
    const [telemetry, stranded] = await Promise.all([this.telemetry.latestTelemetryForJobs(selected.map(job => job.jobId)), this.stranded?.deliveredForManagers() ?? Promise.resolve(new Map())]);
    return this.project(selected, all, telemetry, false, stranded);
  }

  /** All non-terminal managers with children plus every descendant; never globally truncates terminal children. */
  async supervisionCandidates(): Promise<FleetJobView[]> {
    const all = await this.states.jobs();
    const childParentThreads = new Set(all.map(job => job.parentThreadId).filter((value): value is string => !!value));
    const managers = all.filter(job => ['running', 'parked'].includes(job.status) && job.tasks.some(task => !!task.threadId && childParentThreads.has(task.threadId)));
    const managerThreads = new Set(managers.flatMap(job => job.tasks.map(task => task.threadId).filter((value): value is string => !!value)));
    const selected = [...managers];
    const selectedIds = new Set(selected.map(job => job.jobId));
    for (let cursor = 0; cursor < selected.length; cursor++) {
      const parent = selected[cursor];
      for (const task of parent.tasks) if (task.threadId) managerThreads.add(task.threadId);
      for (const child of all) if (!selectedIds.has(child.jobId) && child.parentThreadId && managerThreads.has(child.parentThreadId)) {
        selected.push(child); selectedIds.add(child.jobId);
      }
    }
    const [telemetry, stranded] = await Promise.all([this.telemetry.latestTelemetryForJobs(selected.map(job => job.jobId)), this.stranded?.deliveredForManagers() ?? Promise.resolve(new Map())]);
    return this.project(selected, all, telemetry, false, stranded);
  }

  async job(jobId: string): Promise<FleetJobView | undefined> {
    const [job, all] = await Promise.all([this.states.job(jobId), this.states.jobs()]);
    if (!job) return undefined;
    const [telemetry, stranded] = await Promise.all([this.telemetry.telemetryForJob(jobId), this.stranded?.deliveredForManagers() ?? Promise.resolve(new Map())]);
    return (await this.project([job], all, { [jobId]: telemetry }, true, stranded))[0];
  }

  private bound(jobs: AgentJob[], limit = 25, includeFinished = true): AgentJob[] {
    const visible = jobs.filter(job => !job.dismissedAt);
    const active = visible.filter(job => ['running', 'parked'].includes(job.status));
    if (!includeFinished) return active.sort((left, right) => right.createdAt - left.createdAt);
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const terminal = visible.filter(job => !['running', 'parked'].includes(job.status))
      .sort((left, right) => right.createdAt - left.createdAt).slice(0, boundedLimit);
    return [...active, ...terminal].sort((left, right) => right.createdAt - left.createdAt);
  }

  private requiredCaller(callerThreadId?: string): string {
    const caller = callerThreadId?.trim();
    if (!caller) throw new Error('scope:"mine" requires a calling chat thread. Use scope:"all" only for an authorized fleet-wide read.');
    return caller;
  }

  private async project(
    selected: AgentJob[],
    all: AgentJob[],
    telemetry: Record<string, Record<number, AgentJobTaskTelemetry>>,
    detailed: boolean,
    stranded: Map<string, { stateKey: string; reason: string }>,
  ): Promise<FleetJobView[]> {
    const index = new AgentLineageIndex(all);
    const roots = [...new Set(selected.map(job => index.lineage(job).rootThreadId).filter((value): value is string => !!value))];
    const titles = await this.titles.titlesForThreadIds(roots);
    return selected.map(job => this.jobView(job, index, titles, telemetry[job.jobId] ?? {}, detailed, stranded));
  }

  private jobView(
    job: AgentJob,
    index: AgentLineageIndex,
    titles: Record<string, string | null>,
    telemetry: Record<number, AgentJobTaskTelemetry>,
    detailed: boolean,
    stranded: Map<string, { stateKey: string; reason: string }>,
  ): FleetJobView {
    const lineage = index.lineage(job);
    const fields = {
      parentThreadId: job.parentThreadId ?? null,
      parentChannel: job.parentChannel ?? null,
      parentAgentId: job.parentAgentId ?? null,
      parentJobId: lineage.parentJobId,
      parentTaskIndex: lineage.parentTaskIndex,
      rootThreadId: lineage.rootThreadId,
      rootChatTitle: lineage.rootThreadId ? (titles[lineage.rootThreadId] ?? null) : null,
    };
    return {
      jobId: job.jobId,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      ...fields,
      waitingOnChildren: job.waitingOnChildren ?? 0,
      taskCount: job.taskCount,
      orphanedChildNoticeCount: job.orphanedChildNotices?.length ?? 0,
      elapsed: this.elapsed(job.createdAt, job.finishedAt ?? undefined),
      stoppedBy: job.stoppedBy,
      stopReason: job.stopReason,
      ...(detailed ? { error: job.error, results: job.results, orphanedChildNotices: job.orphanedChildNotices ?? [] } : {}),
      tasks: job.tasks.map((task, taskIndex) => this.taskView(job, task, taskIndex, fields, telemetry[taskIndex], detailed, stranded.get(`${ job.jobId }#${ taskIndex }`))),
    };
  }

  private taskView(job: AgentJob, task: AgentJobTask, taskIndex: number, fields: FleetObject, telemetry?: AgentJobTaskTelemetry, detailed = false, stranded?: { stateKey: string; reason: string }): FleetTaskView {
    const latestCheckin = telemetry?.latestCheckin ?? null;
    const startedAt = task.startedAt ?? job.createdAt;
    // TODO(#1991): include authoritative model/tool RunActivity in the state projection.
    const lastActivityAt = Math.max(startedAt, latestCheckin?.createdAt ?? 0, task.finishedAt ?? 0, task.returnedAt ?? 0);
    return {
      taskIndex,
      agentId: task.agentId,
      label: task.label,
      taskId: task.taskId,
      status: task.status,
      visibility: task.visibility ?? job.visibility ?? 'hidden',
      promotedToTab: task.promotedToTab === true,
      contract: task.contract?.name ?? 'result',
      returned: !!task.returnedAt,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
      returnedAt: task.returnedAt ? new Date(task.returnedAt).toISOString() : null,
      completionDeliveredAt: task.completionDeliveredAt ? new Date(task.completionDeliveredAt).toISOString() : null,
      lastActivityAt: new Date(lastActivityAt).toISOString(),
      elapsed: this.elapsed(task.startedAt ?? job.createdAt, task.finishedAt),
      threadId: task.threadId ?? null,
      parentJobId: fields.parentJobId as string | null,
      parentTaskIndex: fields.parentTaskIndex as number | null,
      rootThreadId: fields.rootThreadId as string | null,
      ...fields,
      latestCheckin: this.checkin(latestCheckin, !detailed),
      wakeAt: task.wakeAt ? new Date(task.wakeAt).toISOString() : null,
      stranded: stranded ? { ...stranded, detectedAt: 0, alertedAt: 0 } : null,
      result: task.result,
      completion: task.completion,
      undeliveredOrchestratorMessages: telemetry?.undeliveredMessages ?? 0,
      ...(detailed ? { checkins: (telemetry?.checkins ?? []).map(item => this.checkin(item, false)) } : {}),
    };
  }

  private checkin(checkin: AgentJobCheckin | null, compact: boolean) {
    if (!checkin) return null;
    return {
      step: checkin.step,
      summary: compact ? checkin.summary.slice(0, 240) : checkin.summary,
      blockers: checkin.blockers,
      percent: checkin.percent,
      ...(compact ? {} : { files: checkin.filesTouched }),
      time: new Date(checkin.createdAt).toISOString(),
    };
  }

  private elapsed(start: number, finish?: number): string {
    return `${ Math.max(0, Math.round(((finish ?? this.now()) - start) / 1000)) }s`;
  }
}
