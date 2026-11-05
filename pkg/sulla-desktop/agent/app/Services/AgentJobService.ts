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
import type { AgentJob, AgentJobResult, AgentJobTask, CreateJobOptions } from '../../tools/agents/jobRegistry';
export class AgentJobService extends Service {
  constructor(private readonly repository: AgentJobRepository, private readonly runtime: JobRuntimeRegistry, private readonly recovery: JobRecoveryService, private readonly clock: Clock, private readonly idGenerator: JobIdGenerator, private readonly taskLocator: JobTaskLocator, private readonly states: AgentStateService) { super(); this.runtime.start(); }
async createJob(
  taskInput: number | AgentJobTask[],
  parentChannel?: string,
  parentThreadId?: string,
  options: CreateJobOptions = {},
): Promise<AgentJob> {
  await this.recovery.ensureHydrated();
    const tasks = Array.isArray(taskInput) ? taskInput : [];
  const taskCount = Array.isArray(taskInput) ? taskInput.length : taskInput;
  const jobId = this.idGenerator.next();
  const job: AgentJob = {
    jobId,
    status:     'running',
    createdAt:  this.clock.now().getTime(),
    finishedAt: null,
    taskCount,
    results:    [],
    tasks,
    parentChannel,
    parentThreadId,
    parentAgentId: options.parentAgentId,
    visibility: options.visibility ?? 'hidden',
    completionDeliveredAt: null,
    dismissedAt: null,
  };
  await this.states.create(job);
  void import('../../extensions/HookRegistry').then(({ extensionHooks }) => extensionHooks.runAction('on_agent_job_start', { jobId, taskCount, parentAgentId: options.parentAgentId }));
  this.runtime.abortControllers.set(jobId, new AbortController());
  return job;
}
/** Update one task in the hot cache and its durable display copy. */
async updateJobTask(jobId: string, index: number, patch: Partial<AgentJobTask>): Promise<void> {
  await this.states.update(jobId, job => {
    if (!job.tasks[index]) return job;
    const nextPatch = job.status === 'stopped' && patch.status && patch.status !== 'stopped' ? { ...patch, status: 'stopped' as const } : patch;
    return { ...job, tasks: job.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...nextPatch } : task) };
  });
}
/** Visible this.runtime.jobs for one graph thread. Hot cache wins over persisted rows. */
async getJobsForParentThread(parentThreadId: string): Promise<AgentJob[]> {
  return (await this.states.descendants(parentThreadId)).filter(job => !job.dismissedAt);
}
async dismissJobTask(jobId: string, parentThreadId: string, taskIndex: number): Promise<boolean> {
  const job = await this.states.job(jobId);
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
/** The abort signal for a job, for wiring into its sub-agents' state. */
getJobAbortSignal(jobId: string): AbortSignal | undefined {
  return this.runtime.abortControllers.get(jobId)?.signal;
}
/**
 * Request cancellation of a running job. Fires its AbortController (which the
 * sub-agent graphs check cooperatively between steps) and marks it 'stopped'.
 * Cooperative, not preemptive: an in-flight LLM/tool call finishes first, then
 * the loop sees the aborted signal and unwinds. Returns the outcome so the tool
 * can report accurately.
 */
abortJob(jobId: string): 'stopped' | 'not-found' | 'already-finished' {
  const job = this.runtime.jobs.get(jobId);
  if (!job) return 'not-found';
  if (!['running', 'parked'].includes(job.status)) return 'already-finished';
  this.runtime.abortControllers.get(jobId)?.abort();
  const finishedAt = this.clock.now().getTime();
  const next = { ...job, status: 'stopped' as const, finishedAt, waitingOnChildren: 0,
    tasks: job.tasks.map(task => ['running', 'queued', 'parked'].includes(task.status)
      ? { ...task, status: 'stopped' as const, finishedAt }
      : task) };
  // Compatibility path is synchronous; state remains unchanged until the durable write succeeds.
  void this.states.commit(next).catch(error => console.error('[AgentJobService] stop persistence failed:', error));
  return 'stopped';
}
async stopJobCascade(jobId: string): Promise<'stopped' | 'not-found' | 'already-finished'> {
  const root = await this.states.job(jobId);
  if (!root) return 'not-found';
  if (!['running', 'parked'].includes(root.status)) return 'already-finished';
  const stoppedIds = await this.states.stopCascade(jobId);
  for (const stoppedId of stoppedIds) this.runtime.abortControllers.get(stoppedId)?.abort();
  return stoppedIds.length > 0 ? 'stopped' : 'already-finished';
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
async parkJobTask(jobId: string, taskIndex: number, waitingOnChildren: number): Promise<void> {
  const job = await this.states.job(jobId); if (!job || job.tasks[taskIndex]?.status !== 'running') return;
  await this.states.transition(jobId, taskIndex, { status: 'parked' }, { waitingOnChildren });
}
async resumeParkedJob(jobId: string, taskIndex: number): Promise<void> {
  const job = await this.states.job(jobId); if (!job || job.tasks[taskIndex]?.status !== 'parked') return;
  await this.states.transition(jobId, taskIndex, { status: 'running' }, { waitingOnChildren: 0, finishedAt: null });
}

async completeJob(jobId: string, results: AgentJobResult[]): Promise<void> {
  const source = await this.states.job(jobId);
  const job = source ? structuredClone(source) : undefined;
  if (!job) return;
  this.runtime.abortControllers.delete(jobId);

  // Terminal verdicts are immutable. A stopped job may still settle its
  // in-flight promise afterwards, but only its partial result payload changes.
  if (job.status === 'completed' || job.status === 'failed') return;
  if (job.status === 'stopped') {
    job.results = results;
    job.tasks = job.tasks.map(task => task.status === 'running' || task.status === 'queued' || task.status === 'parked'
      ? { ...task, status: 'stopped', finishedAt: this.clock.now().getTime() }
      : task);
    await this.states.commit(job);

    return;
  }

  const failed = results.find(result => result.status === 'error');
  job.status = failed ? 'failed' : 'completed';
  job.finishedAt = this.clock.now().getTime();
  job.results = results;
  job.error = failed?.output;
  job.tasks = job.tasks.map((task, index) => {
    const result = results[index];
    if (!result) return task;
    return { ...task, status: result.status, threadId: result.threadId || task.threadId, finishedAt: task.finishedAt ?? this.clock.now().getTime() };
  });

  void import('../../extensions/HookRegistry').then(({ extensionHooks }) => extensionHooks.runAction('on_agent_job_finish', { jobId, status: job.status, results }));

  await this.states.commit(job);
}
/** Persist one settled task before its siblings finish. */
async recordTaskCompletion(jobId: string, taskIndex: number, result: AgentJobResult): Promise<void> {
  const source = await this.states.job(jobId);
  const job = source ? structuredClone(source) : undefined;
  if (!job?.tasks[taskIndex]) return;
  job.results[taskIndex] = result;
  job.tasks[taskIndex] = { ...job.tasks[taskIndex],
    status: result.status,
    threadId: result.threadId || job.tasks[taskIndex].threadId,
    finishedAt: job.tasks[taskIndex].finishedAt ?? this.clock.now().getTime(),
    completion: result };
  await this.states.commit(job);
}
/** Acknowledge only the task whose contract actually entered a parent turn. */
async markTaskCompletionDelivered(jobId: string, taskIndex: number): Promise<void> {
  const source = await this.states.job(jobId);
  const job = source ? structuredClone(source) : undefined;
  if (!job?.tasks[taskIndex] || job.tasks[taskIndex].completionDeliveredAt) return;
  job.tasks[taskIndex] = { ...job.tasks[taskIndex], completionDeliveredAt: this.clock.now().getTime() };
  if (job.tasks.every(task => task.completionDeliveredAt)) job.completionDeliveredAt = this.clock.now().getTime();
  await this.states.commit(job);

}
/** Mark a persisted completion delivered only after the graph wake was sent. */
async markCompletionDelivered(jobId: string): Promise<void> {
  const source = await this.states.job(jobId);
  if (!source || source.completionDeliveredAt) return;
  await this.states.commit({ ...source, completionDeliveredAt: this.clock.now().getTime() });
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
async recordTaskReturn(jobId: string, taskIndex: number, patch: {
  result:  unknown;
  summary?: string;
  status:  AgentJobTask['status'];
}): Promise<AgentJob> {
  const source = await this.states.job(jobId);
  const job = source ? structuredClone(source) : undefined;
  const task = job?.tasks[taskIndex];
  if (!job || !task) throw new Error(`Job "${ jobId }" has no task ${ taskIndex }.`);
  if (task.returnedAt) throw new Error(`Job "${ jobId }" already returned its contract.`);
  if (!['running', 'parked'].includes(job.status)) throw new Error(`Job "${ jobId }" is ${ job.status }; it no longer accepts a return.`);
  job.tasks[taskIndex] = {
    ...task,
    result:     patch.result,
    summary:    patch.summary,
    returnedAt: this.clock.now().getTime(),
    // Hidden runners settle the status when their graph returns; a tab is
    // finished by this return alone.
    ...(job.visibility === 'tab' ? { status: patch.status, finishedAt: this.clock.now().getTime() } : {}),
  };
  await this.states.commit(job);
  return job;
}

/** Mark a hidden child as opened in a chat tab (rail shows the tab pill). */
async markTaskPromoted(jobId: string, taskIndex: number): Promise<AgentJobTask | undefined> {
  const source = await this.states.job(jobId);
  const job = source ? structuredClone(source) : undefined;
  if (!job?.tasks[taskIndex]) return undefined;
  job.tasks[taskIndex] = { ...job.tasks[taskIndex], promotedToTab: true };
  await this.states.commit(job);
  return job.tasks[taskIndex];
}

async failJob(jobId: string, error: string): Promise<void> {
  const source = await this.states.job(jobId);
  const job = source ? structuredClone(source) : undefined;
  if (!job) return;
  this.runtime.abortControllers.delete(jobId);

  // Terminal verdicts are immutable; late promise rejection cannot clobber them.
  if (!['running', 'parked'].includes(job.status)) return;

  job.status = 'failed';
  job.finishedAt = this.clock.now().getTime();
  job.error = error;
  job.tasks = job.tasks.map(task => task.status === 'running' || task.status === 'queued' || task.status === 'parked'
    ? { ...task, status: 'error', finishedAt: this.clock.now().getTime() }
    : task);

  await this.states.commit(job);
}

}
