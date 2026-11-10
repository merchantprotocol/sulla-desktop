// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentJobCheckin, AgentJobTaskTelemetry } from '../../database/models/AgentJobMessagingModel';
import type { ConversationTitleRepository } from '../Repositories/ConversationTitleRepository';
import type { AgentJobReviewItem } from '../Repositories/AgentJobReviewItemRepository';
import type { AgentStateService } from './AgentStateService';
import { AgentLineageIndex } from './AgentLineageIndex';
import type { FleetJobView, FleetReviewItemView, FleetTaskView } from './AgentFleetTypes';
import { AgentTaskActivityProjector } from './AgentTaskActivityProjector';
import { DescendantWaitCounter } from './DescendantWaitCounter';

export interface AgentFleetTelemetryReader {
  telemetryForJob(jobId: string): Promise<Record<number, AgentJobTaskTelemetry>>;
  latestTelemetryForJobs(jobIds: string[]): Promise<Record<string, Record<number, AgentJobTaskTelemetry>>>;
}

/** Reads open tracked review items; closed items are excluded by the reader. */
export interface AgentFleetReviewReader {
  openReviewItemsForTasks(jobIds: string[]): Promise<Record<string, AgentJobReviewItem[]>>;
}

export interface AgentFleetRequest {
  scope: 'mine' | 'all';
  callerThreadId?: string;
  limit?: number;
  includeFinished?: boolean;
}

type FleetObject = Record<string, unknown>;

/** Per-read state shared by every job and task view built from one lineage snapshot. */
interface FleetReadContext {
  index: AgentLineageIndex;
  waits: DescendantWaitCounter;
  titles: Record<string, string | null>;
  detailed: boolean;
  stranded: Map<string, { stateKey: string; reason: string }>;
  openTasksOnly: boolean;
  reviews: Record<string, AgentJobReviewItem[]>;
}

/** Authoritative, lineage-enriched fleet read model consumed by agent supervision tools. */
export class AgentFleetProjectionService {
  constructor(
    private readonly states: AgentStateService,
    private readonly telemetry: AgentFleetTelemetryReader,
    private readonly titles: ConversationTitleRepository,
    private readonly now: () => number = Date.now,
    private readonly stranded?: { deliveredForManagers(): Promise<Map<string, { stateKey: string; reason: string }>> },
    private readonly activity = new AgentTaskActivityProjector({ lastActivityAt: () => undefined }, now),
    private readonly reviews?: AgentFleetReviewReader,
  ) {}

  async list(request: AgentFleetRequest): Promise<FleetJobView[]> {
    const all = await this.states.jobs();
    const index = new AgentLineageIndex(all);
    const scoped = request.scope === 'mine'
      ? index.descendants(this.requiredCaller(request.callerThreadId))
      : all;
    const selected = this.bound(scoped, request.limit, request.includeFinished);
    const [telemetry, stranded, reviews] = await Promise.all([this.telemetry.latestTelemetryForJobs(selected.map(job => job.jobId)), this.stranded?.deliveredForManagers() ?? Promise.resolve(new Map()), this.openReviews(selected)]);
    return this.project(selected, all, telemetry, false, stranded, request.includeFinished === false, reviews);
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
    const [telemetry, stranded, reviews] = await Promise.all([this.telemetry.latestTelemetryForJobs(selected.map(job => job.jobId)), this.stranded?.deliveredForManagers() ?? Promise.resolve(new Map()), this.openReviews(selected)]);
    return this.project(selected, all, telemetry, false, stranded, false, reviews);
  }

  async job(jobId: string): Promise<FleetJobView | undefined> {
    const [job, all] = await Promise.all([this.states.job(jobId), this.states.jobs()]);
    if (!job) return undefined;
    const [telemetry, stranded, reviews] = await Promise.all([this.telemetry.telemetryForJob(jobId), this.stranded?.deliveredForManagers() ?? Promise.resolve(new Map()), this.openReviews([job])]);
    return (await this.project([job], all, { [jobId]: telemetry }, true, stranded, false, reviews))[0];
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

  /** Skips the read entirely when there is nothing to list; one indexed query otherwise. */
  private async openReviews(jobs: AgentJob[]): Promise<Record<string, AgentJobReviewItem[]>> {
    if (!this.reviews || jobs.length === 0) return {};
    return this.reviews.openReviewItemsForTasks(jobs.map(job => job.jobId));
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
    openTasksOnly = false,
    reviews: Record<string, AgentJobReviewItem[]> = {},
  ): Promise<FleetJobView[]> {
    const index = new AgentLineageIndex(all);
    const roots = [...new Set(selected.map(job => index.lineage(job).rootThreadId).filter((value): value is string => !!value))];
    const titles = await this.titles.titlesForThreadIds(roots);
    const view: FleetReadContext = { index, waits: new DescendantWaitCounter(index), titles, detailed, stranded, openTasksOnly, reviews };
    return selected
      .map(job => this.jobView(job, view, telemetry[job.jobId] ?? {}))
      .filter(job => !openTasksOnly || job.tasks.length > 0);
  }

  private jobView(job: AgentJob, context: FleetReadContext, telemetry: Record<number, AgentJobTaskTelemetry>): FleetJobView {
    const { index, titles, detailed } = context;
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
      tasks: job.tasks
        .map((task, taskIndex) => this.taskView(job, task, taskIndex, fields, context, telemetry[taskIndex]))
        .filter(task => !context.openTasksOnly || AgentTaskActivityProjector.isOpen(task.state)),
    };
  }

  private taskView(job: AgentJob, task: AgentJobTask, taskIndex: number, fields: FleetObject, context: FleetReadContext, telemetry?: AgentJobTaskTelemetry): FleetTaskView {
    const { detailed, stranded: strandedMap } = context;
    const stranded = strandedMap.get(`${ job.jobId }#${ taskIndex }`);
    const latestCheckin = telemetry?.latestCheckin ?? null;
    const startedAt = task.startedAt ?? job.createdAt;
    const activity = this.activity.project(job, task, taskIndex, latestCheckin, telemetry?.lastMessageDeliveredAt ?? null);
    return {
      taskIndex,
      agentId: task.agentId,
      label: task.label,
      taskId: task.taskId,
      status: activity.state,
      lifecycleStatus: task.status,
      state: activity.state,
      visibility: task.visibility ?? job.visibility ?? 'hidden',
      promotedToTab: task.promotedToTab === true,
      contract: task.contract?.name ?? 'result',
      returned: !!task.returnedAt,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
      returnedAt: task.returnedAt ? new Date(task.returnedAt).toISOString() : null,
      completionDeliveredAt: task.completionDeliveredAt ? new Date(task.completionDeliveredAt).toISOString() : null,
      lastActivityAt: new Date(activity.lastActivityAt).toISOString(),
      elapsed: this.elapsed(task.startedAt ?? job.createdAt, task.finishedAt),
      threadId: task.threadId ?? null,
      parentJobId: fields.parentJobId as string | null,
      parentTaskIndex: fields.parentTaskIndex as number | null,
      rootThreadId: fields.rootThreadId as string | null,
      ...fields,
      latestCheckin: this.checkin(latestCheckin, !detailed),
      descendantsRunning: context.waits.runningDescendantsOf(task),
      wakeAt: task.wakeAt ? new Date(task.wakeAt).toISOString() : null,
      stranded: stranded ? { ...stranded, detectedAt: 0, alertedAt: 0 } : null,
      result: task.result,
      completion: task.completion,
      undeliveredOrchestratorMessages: telemetry?.undeliveredMessages ?? 0,
      openReviewItems: this.openReviewItemsFor(context.reviews[job.jobId] ?? [], taskIndex),
      ...(detailed ? { checkins: (telemetry?.checkins ?? []).map(item => this.checkin(item, false)) } : {}),
    };
  }

  private openReviewItemsFor(items: AgentJobReviewItem[], taskIndex: number): FleetReviewItemView[] {
    return items
      .filter(item => item.taskIndex === taskIndex && item.status !== 'closed')
      .map(item => ({ id: item.id, text: item.text, status: item.status }));
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
