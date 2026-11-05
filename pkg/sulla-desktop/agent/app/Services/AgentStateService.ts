// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentStateStore {
  allJobs(): Promise<AgentJob[]>;
  insertJob(job: AgentJob): Promise<void>;
  replaceState(job: AgentJob): Promise<void>;
  cascadeJobs(jobId: string): Promise<AgentJob[]>;
  replaceStateIfActivityUnchanged(job: AgentJob, taskIndex: number, observedActivity: number | null): Promise<boolean>;
}
export interface AgentStateCache { jobs: Map<string, AgentJob>; }
export type AgentStateChangeListener = (version: number) => void;

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

  private async refreshUnsafe(): Promise<AgentJob[]> {
    const durable = await this.store.allJobs();
    const durableIds = new Set(durable.map(job => job.jobId));
    for (const cachedId of this.cache.jobs.keys()) if (!durableIds.has(cachedId)) this.cache.jobs.delete(cachedId);
    for (const persisted of durable) {
      const derived = this.withDerivedStatus(persisted);
      if (derived.status !== persisted.status) await this.mutateJob(persisted.jobId, current => this.withDerivedStatus(current));
      else this.cache.jobs.set(persisted.jobId, persisted);
    }
    return Array.from(this.cache.jobs.values()).filter(job => durableIds.has(job.jobId));
  }

  /** Reconciliation-only read, used to establish the readiness gate itself. */
  async jobsBeforeReady(): Promise<AgentJob[]> { return this.refreshUnsafe(); }
  async refresh(): Promise<AgentJob[]> { await this.ready(); return this.refreshUnsafe(); }
  async jobs(): Promise<AgentJob[]> { return this.refresh(); }
  async job(jobId: string): Promise<AgentJob | undefined> { await this.refresh(); return this.cache.jobs.get(jobId); }
  /** Write-side lookup. Lifecycle writes must not wait for boot reconciliation. */
  async jobForWrite(jobId: string): Promise<AgentJob | undefined> {
    const cached = this.cache.jobs.get(jobId);
    if (cached) return cached;
    await this.refreshUnsafe();
    return this.cache.jobs.get(jobId);
  }

  async descendants(parentThreadId: string): Promise<AgentJob[]> {
    const jobs = await this.jobs(); const threadIds = new Set([parentThreadId]); const descendants: AgentJob[] = [];
    let added = true;
    while (added) { added = false; for (const job of jobs) {
      if (descendants.includes(job) || !job.parentThreadId || !threadIds.has(job.parentThreadId)) continue;
      descendants.push(job); for (const task of job.tasks) if (task.threadId) threadIds.add(task.threadId); added = true;
    } }
    return descendants.sort((a, b) => a.createdAt - b.createdAt);
  }

  async list(limit = 25, includeFinished = true): Promise<AgentJob[]> {
    const jobs = (await this.jobs()).filter(job => !job.dismissedAt);
    const active = jobs.filter(job => ['running', 'parked'].includes(job.status));
    if (!includeFinished) return active.sort((a, b) => b.createdAt - a.createdAt);
    const terminal = jobs.filter(job => !['running', 'parked'].includes(job.status)).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.min(100, Math.max(1, limit)));
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
    const next = this.withDerivedStatus(job); await this.store.insertJob(next); this.cache.jobs.set(next.jobId, next); this.emitChange(); return next;
  }

  async claimInterruptedJobs(maxResumes = 2): Promise<{ resumable: AgentJob[]; exhausted: AgentJob[] }> {
    const resumable: AgentJob[] = []; const exhausted: AgentJob[] = [];
    const candidates = (await this.store.allJobs()).filter(job => job.status === 'running' && job.visibility !== 'tab')
      .sort((left, right) => left.createdAt - right.createdAt || left.jobId.localeCompare(right.jobId));
    for (const candidate of candidates) {
      const exhaustedLimit = (candidate.restartResumeCount ?? 0) >= maxResumes;
      const changed = await this.mutateJob(candidate.jobId, current => current.status !== 'running' || current.visibility === 'tab' ? undefined
        : exhaustedLimit ? { ...current, status: 'failed', error: 'runtime restart recovery limit exceeded', finishedAt: Date.now(), waitingOnChildren: 0 }
          : { ...current, restartResumeCount: (current.restartResumeCount ?? 0) + 1 }, undefined, false);
      if (changed) (exhaustedLimit ? exhausted : resumable).push(changed);
    }
    return { resumable, exhausted };
  }

  /** The only whole-row mutation boundary: latest durable read, mutation, write, cache, and publish share one per-job queue. */
  async mutateJob(jobId: string, mutate: (current: AgentJob) => AgentJob | undefined,
    persist?: (next: AgentJob) => Promise<boolean>, deriveStatus = true): Promise<AgentJob | undefined> {
    return this.mutations.run(jobId, async() => {
      const current = (await this.store.allJobs()).find(job => job.jobId === jobId);
      if (!current) return undefined;
      const candidate = mutate(structuredClone(current));
      if (!candidate) return undefined;
      const next = deriveStatus ? this.withDerivedStatus(candidate) : candidate;
      if (persist && !await persist(next)) return undefined;
      if (!persist) await this.store.replaceState(next);
      this.cache.jobs.set(next.jobId, next);
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

  async transitionIfActivityUnchanged(jobId: string, taskIndex: number, observedActivity: number | null, patch: Partial<AgentJobTask>, jobPatch: Partial<AgentJob>): Promise<boolean> {
    const changed = await this.mutateJob(jobId, current => current.tasks[taskIndex] && ['queued', 'running', 'blocked'].includes(current.tasks[taskIndex].status)
      ? { ...current, ...jobPatch, tasks: current.tasks.map((task, index) => index === taskIndex ? { ...task, ...patch } : task) }
      : undefined, next => this.store.replaceStateIfActivityUnchanged(next, taskIndex, observedActivity));
    return Boolean(changed);
  }

  async stopCascade(jobId: string, stoppedBy?: AgentJob['stoppedBy'], reason = 'Stopped'): Promise<string[]> {
    const jobs = await this.store.cascadeJobs(jobId);
    const finishedAt = Date.now(); const stoppedIds: string[] = [];
    for (const job of jobs) {
      const stopped = await this.mutateJob(job.jobId, current => {
        if (!['running', 'parked', 'failed'].includes(current.status)) return undefined;
        return { ...current, status: 'stopped', finishedAt, waitingOnChildren: 0, completionDeliveredAt: finishedAt,
          stoppedBy, stopReason: reason, tasks: current.tasks.map(task => ['queued', 'running', 'parked'].includes(task.status)
            ? { ...task, status: 'stopped', finishedAt } : task) };
      }, undefined, false);
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
    if (statuses.some(value => value === 'error')) status = 'failed';
    else if (statuses.some(value => ['queued', 'running', 'blocked'].includes(value))) status = 'running';
    else if (statuses.some(value => value === 'parked')) status = 'parked';
    else if (statuses.every(value => value === 'stopped')) status = 'stopped';
    else status = 'completed';
    return status === job.status ? job : { ...job, status };
  }
  private emitChange(): void { this.versionValue = Math.max(this.versionValue + 1, Date.now()); this.changes.emit('change', this.versionValue); }
}
