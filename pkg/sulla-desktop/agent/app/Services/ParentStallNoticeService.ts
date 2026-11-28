// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later


import { AgentStallClassification } from '../../../shared/agentState/AgentStallClassification';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import type { ParentNoticeInbox } from '../../services/ParentNoticeInbox';
import type { PendingCompletion } from './AgentCompletionInboxService';
import type { AgentStateProjector, AgentTaskCheckin } from './AgentStateProjector';

interface TaskTelemetry { latestCheckin?: AgentTaskCheckin | null; lastMessageDeliveredAt?: number | null }
interface StallSources {
  jobs(): Promise<AgentJob[]>;
  job(jobId: string): Promise<AgentJob | undefined>;
  telemetry(jobIds: string[]): Promise<Record<string, Record<number, TaskTelemetry>>>;
  waitingForDecision(threadId: string): Promise<boolean>;
}
interface StallCandidate {
  jobId: string;
  taskIndex: number;
  childThread: string;
  channel: string;
  parentThread: string;
  label: string;
  baseline: string;
  hungTool?: string;
}
interface StallEpisode { baseline: string; dedupeKey: string; channel: string; parentThread: string }

/** Process-local, nonterminal alerts from the same quiet/probe policy the human sees. */
export class ParentStallNoticeService {
  private readonly episodes = new Map<string, StallEpisode>();
  private nextEpisode = 0;
  private lifecycle = 0;
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;

  constructor(private readonly sources: StallSources,
    private readonly projector: Pick<AgentStateProjector, 'taskActivity'>,
    private readonly inbox: ParentNoticeInbox) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan().catch(error => console.warn('[ParentStallNotice] scan failed:', error));
    }, 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lifecycle++;
    this.episodes.clear();
  }

  scan(): Promise<void> {
    return this.scanning ??= this.scanOnce().finally(() => { this.scanning = undefined });
  }

  private async scanOnce(): Promise<void> {
    const lifecycle = this.lifecycle;
    const jobs = await this.sources.jobs();
    const telemetry = await this.sources.telemetry(jobs.map(job => job.jobId));
    const eligible = new Set<string>();
    for (const job of jobs) for (const [index, task] of job.tasks.entries()) {
      const key = this.key(job.jobId, index);
      const candidate = this.candidate(job, task, index, telemetry[job.jobId]?.[index]);
      if (!candidate || !await this.isCurrent(candidate)) continue;
      if (lifecycle !== this.lifecycle) return;
      eligible.add(key);
      if (this.episodes.get(key)?.baseline === candidate.baseline) continue;
      const dedupeKey = `parent-stall:${ key }:${ ++this.nextEpisode }`;
      this.episodes.set(key, { baseline: candidate.baseline, dedupeKey, channel: candidate.channel, parentThread: candidate.parentThread });
      this.inbox.enqueue(candidate.channel, candidate.parentThread, {
        jobId: candidate.jobId,
        taskIndex: index,
        results: [],
        noticeKind: 'stall',
        dedupeKey,
        stall: { childThread: candidate.childThread, baseline: candidate.baseline, label: candidate.label,
          ...(candidate.hungTool ? { hungTool: candidate.hungTool } : {}) },
      });
    }
    if (lifecycle !== this.lifecycle) return;
    for (const key of this.episodes.keys()) if (!eligible.has(key)) this.episodes.delete(key);
  }

  /** Recheck a queued/retried alert at actual handoff; never trust the scan's stale read. */
  async canDeliver(channel: string, threadId: string, entry: PendingCompletion): Promise<boolean> {
    const key = this.key(entry.jobId, entry.taskIndex);
    const episode = this.episodes.get(key);
    if (!entry.stall || !episode || episode.dedupeKey !== entry.dedupeKey || episode.channel !== channel || episode.parentThread !== threadId) return false;
    try {
      const current = await this.isCurrent({
        jobId: entry.jobId, taskIndex: entry.taskIndex, childThread: entry.stall.childThread,
        channel, parentThread: threadId, baseline: entry.stall.baseline,
      });
      if (current) return this.episodes.get(key) === episode;
    } catch (error) {
      console.warn('[ParentStallNotice] handoff revalidation failed:', error);
    }
    if (this.episodes.get(key) === episode) this.episodes.delete(key);
    return false;
  }

  private async isCurrent(input: Omit<StallCandidate, 'label' | 'hungTool'>): Promise<boolean> {
    const [telemetry, decision] = await Promise.all([
      this.sources.telemetry([input.jobId]), this.sources.waitingForDecision(input.childThread),
    ]);
    if (decision) return false;
    // Read the exact job last, then evaluate local activity and liveness synchronously.
    const job = await this.sources.job(input.jobId);
    const task = job?.tasks[input.taskIndex];
    const latest = job && task && this.candidate(job, task, input.taskIndex, telemetry[input.jobId]?.[input.taskIndex]);
    return Boolean(latest && latest.channel === input.channel && latest.parentThread === input.parentThread
      && latest.childThread === input.childThread && latest.baseline === input.baseline);
  }

  private candidate(job: AgentJob, task: AgentJobTask, taskIndex: number, telemetry?: TaskTelemetry): StallCandidate | undefined {
    const { parentChannel, parentThreadId } = job;
    if (!parentChannel?.trim() || !parentThreadId?.trim() || !task.threadId || task.threadId === parentThreadId
      || task.status !== 'running' || task.completion) return undefined;
    const { state, runtimeAlive, lastActivityAt, hungTool } = this.projector.taskActivity(
      job, task, taskIndex, telemetry?.latestCheckin ?? null, telemetry?.lastMessageDeliveredAt ?? null);
    if (!AgentStallClassification.isStalled(state, runtimeAlive)) return undefined;
    return {
      jobId: job.jobId, taskIndex, childThread: task.threadId, channel: parentChannel, parentThread: parentThreadId,
      label: task.label || task.agentId,
      ...(hungTool ? { hungTool } : {}),
      baseline: JSON.stringify([parentChannel, parentThreadId, task.threadId, task.taskId, task.generation ?? 1,
        task.startedAt, task.restartResumeCount, job.restartResumeCount, task.reopenLeaseId, lastActivityAt]),
    };
  }

  private key(jobId: string, taskIndex: number): string { return `${ jobId }:${ taskIndex }` }
}
