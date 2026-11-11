// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';


/** A blocked task is live only while its blocker is open; a returned blocked result is settled. */
function isOpenBlocker(task: AgentJobTask): boolean { return task.status === 'blocked' && !task.returnedAt && !task.finishedAt; }
function isLiveTask(task: AgentJobTask): boolean { return ['queued', 'running', 'parked'].includes(task.status) || isOpenBlocker(task); }
export interface AgentStateStore {
  allJobs(): Promise<AgentJob[]>;
  lineageForParentThread?(parentThreadId: string, limit?: number): Promise<AgentJob[]>;
  job(jobId: string): Promise<AgentJob | undefined>;
  jobsForList(limit: number, includeFinished: boolean): Promise<AgentJob[]>;
  insertJob(job: AgentJob): Promise<void>;
  replaceState(job: AgentJob): Promise<void>;
  cascadeJobs(jobId: string): Promise<AgentJob[]>;
  replaceStateIfActivityUnchanged(job: AgentJob, taskIndex: number, observedActivity: number | null): Promise<boolean>;
}
export interface AgentStateCache { jobs: Map<string, AgentJob>; }
export type AgentStateChangeListener = (version: number) => void;
export type AgentStateMutationPrecondition = (current: AgentJob, candidate: AgentJob) => boolean | Promise<boolean>;

/** Instance-owned serialization for read/modify/write operations on one job. */
export class AgentJobMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(jobId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(jobId, tail);
    await previous.catch(() => undefined);
    try { return await mutation() }
    finally {
      release();
      if (this.tails.get(jobId) === tail) this.tails.delete(jobId);
    }
  }
}

/** Sole write-through owner for durable and process-local agent state. */
export class AgentStateService {
  private versionValue: number;
  private refreshInFlight?: Promise<AgentJob[]>;
  private readonly changes = new EventEmitter();
  private readiness: () => Promise<void> = async() => undefined;
  private readonly pendingTerminalWrites = new Set<string>();
  private readonly pendingTerminalPromises = new Map<string, Promise<void>>();

  constructor(private readonly store: AgentStateStore, private readonly cache: AgentStateCache, now: () => number = Date.now,
    private readonly mutations = new AgentJobMutationQueue()) {
    this.versionValue = now();
  }

  get version(): number { return this.versionValue; }
  setReadiness(readiness: Promise<unknown> | (() => Promise<unknown>)): void {
    // A provider allows transient startup failures to recover without leaving a
    // rejected promise installed for the lifetime of the process.
    this.readiness = async() => { await (typeof readiness === 'function' ? readiness() : readiness) };
  }
  async ready(): Promise<void> { await this.readiness(); }
  onChange(listener: AgentStateChangeListener): () => void {
    this.changes.on('change', listener);
    return () => this.changes.off('change', listener);
  }

  private refreshUnsafe(): Promise<AgentJob[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.loadJobs().finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  private async loadJobs(): Promise<AgentJob[]> {
    const durable = await this.store.allJobs();
    const durableIds = new Set(durable.map(job => job.jobId));
    for (const cachedId of this.cache.jobs.keys()) if (!durableIds.has(cachedId)) this.cache.jobs.delete(cachedId);
    const jobs: AgentJob[] = [];
    for (const persisted of durable) {
      const derived = this.withDerivedStatus(persisted);
      const current = derived.status !== persisted.status
        ? await this.mutateJob(persisted.jobId, current => this.withDerivedStatus(current)) : persisted;
      if (!current) continue;
      this.cache.jobs.set(current.jobId, current);
      jobs.push(current);
    }
    this.trimTerminalCache();
    return jobs;
  }

  /** Keep active/parked work and unsettled results, but do not pin durable history in memory. */
  private trimTerminalCache(): void {
    const settled = Array.from(this.cache.jobs.values()).filter(job =>
      ['completed', 'failed', 'stopped'].includes(job.status)
      && !job.tasks.some(task => isLiveTask(task))
      && (job.status !== 'completed' || job.tasks.every(task => task.returnedAt || ['stopped', 'error'].includes(task.status))))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const job of settled.slice(100)) this.cache.jobs.delete(job.jobId);
  }

  /** Reconciliation-only read, used to establish the readiness gate itself. */
  async jobsBeforeReady(): Promise<AgentJob[]> { return this.refreshUnsafe(); }
  async refresh(): Promise<AgentJob[]> { await this.ready(); return this.refreshUnsafe(); }
  async jobs(): Promise<AgentJob[]> { return this.refresh(); }
  async job(jobId: string): Promise<AgentJob | undefined> { await this.ready(); return this.loadJob(jobId); }
  private async loadJob(jobId: string): Promise<AgentJob | undefined> {
    const persisted = await this.store.job(jobId);
    if (!persisted) { this.cache.jobs.delete(jobId); return undefined; }
    const derived = this.withDerivedStatus(persisted);
    const current = derived.status !== persisted.status
      ? await this.mutateJob(jobId, job => this.withDerivedStatus(job)) : persisted;
    if (current) this.cache.jobs.set(jobId, current);
    this.trimTerminalCache();
    return current;
  }
  /**
   * Runs a durable writer that updates agent_jobs itself (the wrap-up teardown
   * outbox) inside this job's mutation queue, then refreshes the cache from the
   * committed row. Queueing keeps a concurrent whole-row write from reverting it.
   */
  async applyExternalWrite(jobId: string, write: () => Promise<boolean>): Promise<boolean> {
    const applied = await this.mutations.run(jobId, async() => {
      const changed = await write();
      if (changed) await this.loadJobUnqueued(jobId);
      return changed;
    });
    if (applied) { this.pendingTerminalWrites.delete(jobId); this.emitChange(); }
    return applied;
  }
  private async loadJobUnqueued(jobId: string): Promise<AgentJob | undefined> {
    const persisted = await this.store.job(jobId);
    if (!persisted) { this.cache.jobs.delete(jobId); return undefined; }
    this.cache.jobs.set(jobId, persisted);
    this.trimTerminalCache();
    return persisted;
  }
  /** Write-side lookup. Lifecycle writes must not wait for boot reconciliation. */
  async jobForWrite(jobId: string): Promise<AgentJob | undefined> {
    const cached = this.cache.jobs.get(jobId);
    if (cached) return cached;
    return this.loadJob(jobId);
  }

  async descendants(parentThreadId: string): Promise<AgentJob[]> {
    await this.ready();
    if (this.store.lineageForParentThread) {
      const persisted = await this.store.lineageForParentThread(parentThreadId, 100);
      const jobs = persisted.map(job => this.withDerivedStatus(job)).filter(job => !job.dismissedAt);
      for (const job of jobs) this.cache.jobs.set(job.jobId, job);
      this.trimTerminalCache();
      return jobs;
    }
    const jobs = await this.jobs(); const threadIds = new Set([parentThreadId]); const descendants: AgentJob[] = [];
    let added = true;
    while (added) { added = false; for (const job of jobs) {
      if (descendants.includes(job) || !job.parentThreadId || !threadIds.has(job.parentThreadId)) continue;
      descendants.push(job); for (const task of job.tasks) if (task.threadId) threadIds.add(task.threadId); added = true;
    } }
    return descendants.sort((a, b) => a.createdAt - b.createdAt);
  }

  async list(limit = 25, includeFinished = true): Promise<AgentJob[]> {
    await this.ready();
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 25));
    const compact = await this.store.jobsForList(safeLimit, includeFinished);
    // Compact rows are presentation-only: never cache or persist them as whole jobs.
    const jobs = compact.map(job => this.withDerivedStatus(job)).filter(job => !job.dismissedAt).sort((a, b) => b.createdAt - a.createdAt);
    const active = jobs.filter(job => ['running', 'parked'].includes(job.status));
    if (!includeFinished) return active;
    const terminal = jobs.filter(job => !['running', 'parked'].includes(job.status)).slice(0, safeLimit);
    return [...active, ...terminal].sort((a, b) => b.createdAt - a.createdAt);
  }

  isLive(job: AgentJob, task: AgentJobTask): boolean { return ['running', 'parked'].includes(job.status) && ['queued', 'running', 'parked', 'blocked'].includes(task.status); }
  hasPendingTerminalWrite(jobId: string): boolean { return this.pendingTerminalWrites.has(jobId); }
  markPendingTerminalWrite(jobId: string): void { this.pendingTerminalWrites.add(jobId); }
  async awaitPendingTerminalWrite(jobId: string): Promise<void> { await this.pendingTerminalPromises.get(jobId); }
  commitPendingTerminal(job: AgentJob): Promise<void> {
    this.markPendingTerminalWrite(job.jobId);
    const pending = this.commit(job);
    this.pendingTerminalPromises.set(job.jobId, pending);
    void pending.then(() => this.pendingTerminalPromises.delete(job.jobId), () => this.pendingTerminalPromises.delete(job.jobId));
    return pending;
  }

  async create(job: AgentJob): Promise<AgentJob> {
    const next = this.withDerivedStatus(job); await this.store.insertJob(next); this.cache.jobs.set(next.jobId, next); this.trimTerminalCache(); this.emitChange(); return next;
  }

  /** Caches and publishes a job row that was inserted by a reservation write (spawn launch keys). */
  remember(job: AgentJob): AgentJob {
    const next = this.withDerivedStatus(job); this.cache.jobs.set(next.jobId, next); this.trimTerminalCache(); this.emitChange(); return next;
  }

  async claimInterruptedJobs(maxResumes = 2): Promise<{ resumable: AgentJob[]; exhausted: AgentJob[] }> {
    const resumable: AgentJob[] = []; const exhausted: AgentJob[] = [];
    const candidates = (await this.store.allJobs()).filter(job => job.status === 'running' && job.visibility !== 'tab')
      .sort((left, right) => left.createdAt - right.createdAt || left.jobId.localeCompare(right.jobId));
    for (const candidate of candidates) {
      const exhaustedLimit = (candidate.restartResumeCount ?? 0) >= maxResumes;
      let settled = false;
      const changed = await this.mutateJob(candidate.jobId, current => {
        if (current.status !== 'running' || current.visibility === 'tab') return undefined;
        // Every task already returned (e.g. a delivered blocked result): settle silently, never resume or fail it.
        if (!current.tasks.some(task => isLiveTask(task))) { settled = true; return this.withDerivedStatus(current); }
        return exhaustedLimit ? { ...current, status: 'failed', error: 'runtime restart recovery limit exceeded', finishedAt: Date.now(), waitingOnChildren: 0 }
          : { ...current, restartResumeCount: (current.restartResumeCount ?? 0) + 1 };
      }, undefined, false);
      if (changed && !settled) (exhaustedLimit ? exhausted : resumable).push(changed);
    }
    return { resumable, exhausted };
  }

  /** The only whole-row mutation boundary: latest durable read, mutation, write, cache, and publish share one per-job queue. */
  async mutateJob(jobId: string, mutate: (current: AgentJob) => AgentJob | undefined,
    persist?: (next: AgentJob) => Promise<boolean>, deriveStatus = true,
    precondition?: AgentStateMutationPrecondition): Promise<AgentJob | undefined> {
    return this.mutations.run(jobId, async() => {
      const current = await this.store.job(jobId);
      if (!current) return undefined;
      const candidate = mutate(structuredClone(current));
      if (!candidate) return undefined;
      const next = deriveStatus ? this.withDerivedStatus(candidate) : candidate;
      if (precondition && !await precondition(current, next)) return undefined;
      if (persist && !await persist(next)) return undefined;
      if (!persist) await this.store.replaceState(next);
      this.cache.jobs.set(next.jobId, next);
      this.trimTerminalCache();
      this.emitChange();
      this.pendingTerminalWrites.delete(next.jobId);
      return next;
    });
  }

  /** Compatibility name for task-level callers; all writes still enter mutateJob. */
  async update(jobId: string, mutate: (current: AgentJob) => AgentJob): Promise<AgentJob | undefined> {
    return this.mutateJob(jobId, mutate);
  }

  async transition(jobId: string, taskIndex: number, patch: Partial<AgentJobTask>, jobPatch: Partial<AgentJob> = {}): Promise<AgentJob | undefined> {
    return this.update(jobId, current => ({ ...current, ...jobPatch, tasks: current.tasks.map((task, index) => index === taskIndex ? { ...task, ...patch } : task) }));
  }

  async transitionIfActivityUnchanged(jobId: string, taskIndex: number, observedActivity: number | null, patch: Partial<AgentJobTask>, jobPatch: Partial<AgentJob>,
    precondition?: AgentStateMutationPrecondition): Promise<boolean> {
    const changed = await this.mutateJob(jobId, current => current.tasks[taskIndex] && ['queued', 'running', 'blocked'].includes(current.tasks[taskIndex].status)
      ? { ...current, ...jobPatch, tasks: current.tasks.map((task, index) => index === taskIndex ? { ...task, ...patch } : task) }
      : undefined, next => this.store.replaceStateIfActivityUnchanged(next, taskIndex, observedActivity), true, precondition);
    return Boolean(changed);
  }

  /**
   * Stops a job tree. `persist` lets a caller write every row inside its own
   * transaction (custody-locked stops); without it each row uses replaceState.
   */
  async stopCascade(jobId: string, stoppedBy?: AgentJob['stoppedBy'], reason = 'Stopped', persist?: (next: AgentJob) => Promise<boolean>): Promise<string[]> {
    const jobs = await this.store.cascadeJobs(jobId);
    const finishedAt = Date.now(); const stoppedIds: string[] = [];
    for (const job of jobs) {
      const stopped = await this.mutateJob(job.jobId, current => {
        if (!['running', 'parked', 'failed'].includes(current.status)) return undefined;
        return { ...current, status: 'stopped', finishedAt, waitingOnChildren: 0, completionDeliveredAt: finishedAt,
          stoppedBy, stopReason: reason, tasks: current.tasks.map(task => ['queued', 'running', 'parked'].includes(task.status)
            ? { ...task, status: 'stopped', finishedAt } : task) };
      }, persist, false);
      if (stopped) stoppedIds.push(job.jobId);
    }
    return stoppedIds;
  }

  touch(): void { this.emitChange(); }
  async commit(job: AgentJob): Promise<void> {
    await this.mutateJob(job.jobId, () => job);
  }


  private withDerivedStatus(job: AgentJob): AgentJob {
    if (job.status === 'stopped' || job.tasks.length === 0) return job;
    const statuses = job.tasks.map(task => task.status); let status: AgentJob['status'];
    if (job.tasks.some(task => task.status === 'error' && task.completion?.status !== 'completed')) status = 'failed';
    // A task that already returned a blocked result is settled; only an open blocker keeps the job running.
    else if (job.tasks.some(task => ['queued', 'running'].includes(task.status) || isOpenBlocker(task))) status = 'running';
    else if (statuses.some(value => value === 'parked')) status = 'parked';
    else if (statuses.every(value => value === 'stopped')) status = 'stopped';
    else status = 'completed';
    return status === job.status ? job : { ...job, status };
  }
  private emitChange(): void { this.versionValue = Math.max(this.versionValue + 1, Date.now()); this.changes.emit('change', this.versionValue); }
}
