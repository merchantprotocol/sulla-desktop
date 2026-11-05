// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentJobCheckin, AgentJobTaskTelemetry } from '../../database/models/AgentJobMessagingModel';
import type { ConversationTitleRepository } from '../Repositories/ConversationTitleRepository';
import type { AgentStateService } from './AgentStateService';
import { AgentLineageIndex } from './AgentLineageIndex';

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
  ) {}

  async list(request: AgentFleetRequest): Promise<FleetObject[]> {
    const all = await this.states.jobs();
    const index = new AgentLineageIndex(all);
    const scoped = request.scope === 'mine'
      ? index.descendants(this.requiredCaller(request.callerThreadId))
      : all;
    const selected = this.bound(scoped, request.limit, request.includeFinished);
    const telemetry = await this.telemetry.latestTelemetryForJobs(selected.map(job => job.jobId));
    return this.project(selected, all, telemetry, false);
  }

  async job(jobId: string): Promise<FleetObject | undefined> {
    const [job, all] = await Promise.all([this.states.job(jobId), this.states.jobs()]);
    if (!job) return undefined;
    const telemetry = await this.telemetry.telemetryForJob(jobId);
    return (await this.project([job], all, { [jobId]: telemetry }, true))[0];
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
  ): Promise<FleetObject[]> {
    const index = new AgentLineageIndex(all);
    const roots = [...new Set(selected.map(job => index.lineage(job).rootThreadId).filter((value): value is string => !!value))];
    const titles = await this.titles.titlesForThreadIds(roots);
    return selected.map(job => this.jobView(job, index, titles, telemetry[job.jobId] ?? {}, detailed));
  }

  private jobView(
    job: AgentJob,
    index: AgentLineageIndex,
    titles: Record<string, string | null>,
    telemetry: Record<number, AgentJobTaskTelemetry>,
    detailed: boolean,
  ): FleetObject {
    const lineage = index.lineage(job);
    const fields = {
      parentThreadId: job.parentThreadId ?? null,
      parentAgentId: job.parentAgentId ?? null,
      parentJobId: lineage.parentJobId,
      parentTaskIndex: lineage.parentTaskIndex,
      rootThreadId: lineage.rootThreadId,
      rootChatTitle: lineage.rootThreadId ? (titles[lineage.rootThreadId] ?? null) : null,
    };
    return {
      jobId: job.jobId,
      status: job.status,
      ...fields,
      waitingOnChildren: job.waitingOnChildren ?? 0,
      taskCount: job.taskCount,
      elapsed: this.elapsed(job.createdAt, job.finishedAt ?? undefined),
      ...(detailed ? { error: job.error, results: job.results } : {}),
      tasks: job.tasks.map((task, taskIndex) => this.taskView(job, task, taskIndex, fields, telemetry[taskIndex], detailed)),
    };
  }

  private taskView(job: AgentJob, task: AgentJobTask, taskIndex: number, fields: FleetObject, telemetry?: AgentJobTaskTelemetry, detailed = false): FleetObject {
    const latestCheckin = telemetry?.latestCheckin ?? null;
    return {
      taskIndex,
      agentId: task.agentId,
      label: task.label,
      taskId: task.taskId,
      status: task.status,
      visibility: task.visibility ?? job.visibility ?? 'hidden',
      contract: task.contract?.name ?? 'result',
      returned: !!task.returnedAt,
      elapsed: this.elapsed(task.startedAt ?? job.createdAt, task.finishedAt),
      threadId: task.threadId ?? null,
      ...fields,
      latestCheckin: this.checkin(latestCheckin, !detailed),
      undeliveredOrchestratorMessages: telemetry?.undeliveredMessages ?? 0,
      ...(detailed ? { checkins: (telemetry?.checkins ?? []).map(item => this.checkin(item, false)) } : {}),
    };
  }

  private checkin(checkin: AgentJobCheckin | null, compact: boolean): FleetObject | null {
    if (!checkin) return null;
    return {
      step: checkin.step,
      summary: compact ? checkin.summary.slice(0, 240) : checkin.summary,
      ...(compact ? {} : { files: checkin.filesTouched, blockers: checkin.blockers, percent: checkin.percent }),
      time: new Date(checkin.createdAt).toISOString(),
    };
  }

  private elapsed(start: number, finish?: number): string {
    return `${ Math.max(0, Math.round(((finish ?? this.now()) - start) / 1000)) }s`;
  }
}
