// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service, type Clock } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import type { AgentStateService } from './AgentStateService';
import { JobIdGenerator } from './JobIdGenerator';
import { JobRecoveryService } from './JobRecoveryService';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import { JobTaskLocator } from './JobTaskLocator';
import { JobAbortScope } from './JobAbortScope';
import type { StopPrincipalValue } from '../ValueObjects/StopPrincipal';
import { JobStopService } from './JobStopService';
import { JobWrapUpService } from './JobWrapUpService';
import { SpawnDedupeGuard } from './SpawnDedupeGuard';
import { SpawnJobCreator } from './SpawnJobCreator';
import type { AgentJob, AgentJobResult, AgentJobTask, CreateJobOptions, OrphanedChildNotice } from '../../tools/agents/jobRegistry';
export class AgentJobService extends Service {

  constructor(private readonly repository: AgentJobRepository, private readonly runtime: JobRuntimeRegistry, private readonly recovery: JobRecoveryService, private readonly clock: Clock, private readonly idGenerator: JobIdGenerator, private readonly taskLocator: JobTaskLocator, private readonly states: AgentStateService, private readonly stops: JobStopService, private readonly wrapUp: JobWrapUpService, spawnDedupe = new SpawnDedupeGuard(clock)) { super(); this.runtime.start(); this.jobCreator = new SpawnJobCreator(repository, runtime, recovery, clock, idGenerator, spawnDedupe, states); }
  private readonly jobCreator: SpawnJobCreator;
  async createJob(taskInput: number | AgentJobTask[], parentChannel?: string, parentThreadId?: string, options: CreateJobOptions = {}): Promise<AgentJob> {
    return this.jobCreator.create(taskInput, parentChannel, parentThreadId, options);
  }

/** Update one task in the hot cache and its durable display copy. */
async updateJobTask(jobId: string, index: number, patch: Partial<AgentJobTask>): Promise<void> {
  await this.states.mutateJob(jobId, job => {
    if (!job.tasks[index]) return job;
    const protectedPatch = (job.status === 'stopped' || job.tasks[index].status === 'stopped') && patch.status && patch.status !== 'stopped' ? { ...patch, status: 'stopped' as const } : patch;
    // Runner bookkeeping precedes recordTaskCompletion; don't expose a terminal rollup before its diagnostics exist.
    const { status: pendingStatus, ...nonStatusPatch } = protectedPatch;
    const nextPatch = pendingStatus === 'completed' || pendingStatus === 'error' ? nonStatusPatch : protectedPatch;
    return { ...job, tasks: job.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...nextPatch } : task) };
  }, undefined, false);
}
/** Visible this.runtime.jobs for one graph thread. Hot cache wins over persisted rows. */
async getJobsForParentThread(parentThreadId: string): Promise<AgentJob[]> {
  return (await this.states.jobs()).filter(job => job.parentThreadId === parentThreadId && !job.dismissedAt).sort((a, b) => a.createdAt - b.createdAt);
}
/** Count direct open child tasks while treating a queued hard stop as closed immediately. */
async openChildrenForThread(parentThreadId: string): Promise<number> {
  return (await this.states.jobs()).filter(job => job.parentThreadId === parentThreadId && !this.states.hasPendingTerminalWrite(job.jobId))
    .reduce((count, job) => count + (['running','parked'].includes(job.status) ? job.tasks.filter(task => ['queued','running','parked'].includes(task.status)).length : 0), 0);
}

async dismissJobTask(jobId: string, parentThreadId: string, taskIndex: number): Promise<boolean> {
  const job = await this.states.jobForWrite(jobId);
  if (job?.parentThreadId !== parentThreadId || !job.tasks[taskIndex]) return false;
  await this.states.update(jobId, current => {
    const tasks = current.tasks.map((task, index) => index === taskIndex ? { ...task, dismissed: true } : task);
    return { ...current, tasks, ...(tasks.length > 0 && tasks.every(task => task.dismissed) ? { dismissedAt: this.clock.now().getTime() } : {}) };
  });
  return true;
}
/** Keep a job's dead-run watcher until releaseJobWatcher (tab this.runtime.jobs). */
registerJobWatcher(jobId: string, stop: () => void): void {
  this.runtime.watchers.get(jobId)?.();
  this.runtime.watchers.set(jobId, stop);
}
releaseJobWatcher(jobId: string): void {
  this.runtime.watchers.get(jobId)?.();
  this.runtime.watchers.delete(jobId);
}
/** The task-specific abort signal wired into exactly one delegated runner. */
getTaskAbortSignal(jobId: string, taskIndex: number): AbortSignal | undefined { return this.runtime.abortScopes.get(jobId)?.taskSignal(taskIndex); }
abortJob(jobId: string, principal: StopPrincipalValue, reason: string): 'stopped' | 'not-found' | 'already-finished' { return this.stops.abortJob(jobId, principal, reason); }
async stopJobTask(jobId: string, taskIndex: number, principal: StopPrincipalValue, reason: string): Promise<'stopped' | 'not-found' | 'already-finished' | 'forbidden'> { return this.stops.stopTask(jobId, taskIndex, principal, reason); }
async authorizeJobStop(jobId: string, principal: StopPrincipalValue): Promise<'allowed' | 'not-found' | 'forbidden'> { return this.stops.authorize(jobId, principal); }
async stopJobCascade(jobId: string, principal: StopPrincipalValue, reason: string): Promise<'stopped' | 'not-found' | 'already-finished' | 'forbidden'> { return this.stops.stopCascade(jobId, principal, reason); }
async stoppedTaskResult(jobId: string, taskIndex: number, label: string, threadId: string): Promise<AgentJobResult | undefined> {
  const job = await this.getJob(jobId); const task = job?.tasks[taskIndex]; if (task?.status !== 'stopped') return undefined;
  const attribution = task.stoppedBy ?? job?.stoppedBy; const stoppedBy = attribution === 'human' ? 'human' : attribution && 'agentId' in attribution ? attribution.agentId : attribution?.system ?? 'unknown';
  return { label, status: 'stopped', output: `stopped by ${ stoppedBy }: ${ task.stopReason ?? job?.stopReason ?? 'no reason recorded' }`, threadId: threadId || task.threadId || '', contract: task.contract?.name ?? 'result' };
}

async getJob(jobId: string): Promise<AgentJob | undefined> { return this.states.job(jobId); }

async getAllJobs(): Promise<AgentJob[]> { return this.states.jobs(); }

/**
 * Keep every live job, plus only the newest bounded slice of terminal this.runtime.jobs.
 * Exported so the list contract can be checked without a database fixture.
 */
boundJobList(allJobs: AgentJob[], limit: number, includeFinished: boolean): AgentJob[] {
  const visible = allJobs.filter(job => !job.dismissedAt);
  const active = visible.filter(job => job.status === 'running' || job.status === 'parked');
  if (!includeFinished) return active.sort((a, b) => b.createdAt - a.createdAt);

  const finished = visible
    .filter(job => job.status !== 'running' && job.status !== 'parked')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return [...active, ...finished].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Lightweight list read. Unlike getAllJobs(), this never loads the unbounded
 * durable history (including prompts and result payloads) into memory.
 */
async getJobsForList(limit = 25, includeFinished = true): Promise<AgentJob[]> { return this.states.list(limit, includeFinished); }

/**
 * Task status is the source of truth; job.status is a rollup of its
 * tasks — 'running' while any sibling task is still running or queued,
 * 'parked' only once every non-terminal task has parked. A sibling task
 * that is still running must stay visible to restart recovery even while
 * this one task parks (AgentJobRepository.claimInterruptedJobs filters on
 * job-level status).
 */
async parkJobTask(jobId: string, taskIndex: number, waitingOnChildren: number): Promise<boolean> {
  return Boolean(await this.states.mutateJob(jobId, current => current.tasks[taskIndex]?.status === 'running'
    ? { ...current, waitingOnChildren, tasks: current.tasks.map((task, index) => index === taskIndex ? { ...task, status: 'parked' } : task) }
    : undefined));
}

async resumeParkedJob(jobId: string, taskIndex: number): Promise<void> {
  const job = await this.states.jobForWrite(jobId); if (!job || job.tasks[taskIndex]?.status !== 'parked') return;
  await this.states.transition(jobId, taskIndex, { status: 'running' }, { waitingOnChildren: 0, finishedAt: null });
}

async completeJob(jobId: string, results: AgentJobResult[]): Promise<void> {
  this.runtime.abortScopes.delete(jobId); this.wrapUp.jobSettled(jobId);
  const job = await this.states.mutateJob(jobId, current => {
    if (current.status === 'completed') return undefined;
    if (current.status === 'failed') return { ...current, results, error: current.error ?? results.find(result => result.status === 'error')?.output, tasks: current.tasks.map((task, index) => {
      const result = results[index]; return !result ? task : { ...task, status: 'error', threadId: result.threadId || task.threadId,
        finishedAt: task.finishedAt ?? this.clock.now().getTime(), completion: task.completion ?? result };
    }) };
    if (current.status === 'stopped') return { ...current, results, tasks: current.tasks.map(task => ['running','queued','parked'].includes(task.status) ? { ...task, status: 'stopped', finishedAt: this.clock.now().getTime() } : task) };
    const failed = results.find(result => result.status === 'error');
    return { ...current, status: failed ? 'failed' : 'completed', finishedAt: this.clock.now().getTime(), results, error: failed?.output,
      tasks: current.tasks.map((task, index) => { const result = results[index]; return !result || task.status === 'stopped' ? task : { ...task, status: result.status, threadId: result.threadId || task.threadId, finishedAt: task.finishedAt ?? this.clock.now().getTime() }; }) };
  });
  if (job) void import('../../extensions/HookRegistry').then(({ extensionHooks }) => extensionHooks.runAction('on_agent_job_finish', { jobId, status: job.status, results }));
}
/** Persist one settled task before its siblings finish. */
async recordTaskCompletion(jobId: string, taskIndex: number, result: AgentJobResult): Promise<void> {
  this.wrapUp.taskSettled(jobId, taskIndex);
  await this.states.mutateJob(jobId, job => {
    if (!job.tasks[taskIndex]) return job;
    job.results[taskIndex] = result;
    job.tasks[taskIndex] = { ...job.tasks[taskIndex],

      status: job.tasks[taskIndex].status === 'stopped' ? 'stopped' : result.status,

      threadId: result.threadId || job.tasks[taskIndex].threadId,
      finishedAt: job.tasks[taskIndex].finishedAt ?? this.clock.now().getTime(),
      completion: result };
    return job;
  });
}
/** Acknowledge only the task whose contract actually entered a parent turn. */
async markTaskCompletionDelivered(jobId: string, taskIndex: number): Promise<void> {
  await this.states.update(jobId, job => {
    if (!job.tasks[taskIndex] || job.tasks[taskIndex].completionDeliveredAt) return job;
    job.tasks[taskIndex] = { ...job.tasks[taskIndex], completionDeliveredAt: this.clock.now().getTime() };
    if (job.tasks.every(task => task.completionDeliveredAt)) job.completionDeliveredAt = this.clock.now().getTime();
    return job;
  });

}

/** Reopens a completion claim when the receiving turn aborts before its first model response. */
async releaseTaskCompletion(jobId: string, taskIndex: number): Promise<void> {
  await this.states.update(jobId, job => {
    if (!job.tasks[taskIndex]?.completionDeliveredAt) return job;
    job.tasks[taskIndex] = { ...job.tasks[taskIndex], completionDeliveredAt: undefined };
    return { ...job, completionDeliveredAt: undefined };
  });
}
/** Mark a persisted completion delivered only after the graph wake was sent. */
async markCompletionDelivered(jobId: string): Promise<void> {
  await this.states.update(jobId, source => source.completionDeliveredAt ? source : { ...source, completionDeliveredAt: this.clock.now().getTime() });
}

/** Read completed reports whose graph wake was not durably acknowledged. */
async getPendingCompletions(): Promise<AgentJob[]> {
  await this.recovery.ensureHydrated();
  try {
    return await this.repository.pendingCompletions();
  } catch (err) {
    console.warn('[jobRegistry] pending completion read failed:', (err as Error).message);
    return [];
  }
}

/**
 * The job task a delegated child thread belongs to. Hot cache first; a cache
 * miss (a tab child after a restart) reads the persisted row.
 */
async findTaskByThread(threadId: string): Promise<{ job: AgentJob; taskIndex: number } | undefined> {
  return this.taskLocator.findTaskByThread(threadId);
}

/** Delegation depth of a thread: 0 for a top-level chat, else its task depth. */
async delegationDepthForThread(threadId: string | undefined): Promise<number> {
  return this.taskLocator.delegationDepthForThread(threadId);
}

/**
 * Current depth of a thread's own agent: metadata set on the running thread
 * wins when present, else the depth recorded on the job task that owns this
 * thread (0 for a top-level chat). Reading the registry as the fallback means
 * a tab child cannot reset its depth just by never writing the metadata.
 */
async resolveAgentDepth(metadataSubAgentDepth: unknown, threadId: string | undefined): Promise<number> {
  return this.taskLocator.resolveAgentDepth(metadataSubAgentDepth, threadId);
}

/** Tab this.runtime.jobs still open under one parent chat (each holds a renderer tab). */
async countOpenTabJobs(parentThreadId: string): Promise<number> {
  const all = await this.getJobsForParentThread(parentThreadId);
  return all.filter(job => job.visibility === 'tab' && job.status === 'running').length;
}

/**
 * Record a contract-valid return on its task. The caller validated it. A
 * task returns once; a second call is refused so the parent never gets two
 * different answers for one brief.
 */
async recordTaskReturn(jobId: string, taskIndex: number, patch: { result: unknown; summary?: string; status: AgentJobTask['status']; }): Promise<AgentJob> {
  let validationError: Error | undefined;
  const job = await this.states.mutateJob(jobId, current => {
    const task = current.tasks[taskIndex];
    if (!task) { validationError = new Error(`Job "${ jobId }" has no task ${ taskIndex }.`); return undefined; }
    if (task.returnedAt) { validationError = new Error(`Job "${ jobId }" already returned its contract.`); return undefined; }
    if (!['running', 'parked'].includes(current.status)) { validationError = new Error(`Job "${ jobId }" is ${ current.status }; it no longer accepts a return.`); return undefined; }
    const tasks = [...current.tasks]; tasks[taskIndex] = { ...task, result: patch.result, summary: patch.summary, returnedAt: this.clock.now().getTime(), ...(current.visibility === 'tab' ? { status: patch.status, finishedAt: this.clock.now().getTime() } : {}) };
    return { ...current, tasks };
  });
  if (validationError) throw validationError; if (!job) throw new Error(`Job "${ jobId }" was not found.`); this.wrapUp.taskSettled(jobId, taskIndex); return job;
}

/** Mark a hidden child as opened in a chat tab (rail shows the tab pill). */
async markTaskPromoted(jobId: string, taskIndex: number): Promise<AgentJobTask | undefined> {
  const job = await this.states.mutateJob(jobId, current => current.tasks[taskIndex] ? { ...current, tasks: current.tasks.map((task, index) => index === taskIndex ? { ...task, promotedToTab: true } : task) } : undefined);
  return job?.tasks[taskIndex];
}

async failJob(jobId: string, error: string): Promise<void> {
  if (this.states.hasPendingTerminalWrite(jobId)) return;
  this.runtime.abortScopes.delete(jobId); this.wrapUp.jobSettled(jobId);
  await this.states.mutateJob(jobId, current => ['completed','stopped'].includes(current.status) ? undefined : { ...current, status: 'failed', finishedAt: current.finishedAt ?? this.clock.now().getTime(), error,
    tasks: current.tasks.map(task => ['running','queued','parked','error'].includes(task.status) ? { ...task, status: 'error', finishedAt: this.clock.now().getTime(),
      completion: task.completion ?? { label: task.label ?? task.agentId, status: 'error', output: error, threadId: task.threadId ?? '', contract: task.contract?.name ?? 'result' } } : task) });
}

/** Persist and mirror one deduplicated late-child notice on its terminal owner. */
async appendOrphanNotice(jobId: string, notice: OrphanedChildNotice): Promise<boolean> {
  const recorded = await this.repository.appendOrphanNotice(jobId, notice);
  if (recorded) await this.states.refresh();
  return recorded;
}

}
