// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentStateStore {
  allJobs(): Promise<AgentJob[]>;
  insertJob(job: AgentJob): Promise<void>;
  replaceState(job: AgentJob): Promise<void>;
  stopCascade(jobId: string): Promise<string[]>;
  replaceStateIfActivityUnchanged(job: AgentJob, taskIndex: number, observedActivity: number | null): Promise<boolean>;
}
export interface AgentStateCache { jobs: Map<string, AgentJob>; }
export type AgentStateChangeListener = (version: number) => void;

/** Sole write-through owner for durable and process-local agent state. */
export class AgentStateService {
  private versionValue: number;
  private readonly changes = new EventEmitter();
  private readiness: Promise<void> = Promise.resolve();
  private readonly pendingTerminalWrites = new Set<string>();

  constructor(private readonly store: AgentStateStore, private readonly cache: AgentStateCache, now: () => number = Date.now) {
    this.versionValue = now();
  }

  get version(): number { return this.versionValue; }
  setReadiness(readiness: Promise<unknown>): void {
    this.readiness = readiness.then(() => undefined, error => {
      console.error('[AgentStateService] boot reconciliation failed; continuing with periodic repair:', error);
    });
  }
  async ready(): Promise<void> { await this.readiness; }
  onChange(listener: AgentStateChangeListener): () => void {
    this.changes.on('change', listener);
    return () => this.changes.off('change', listener);
  }

  private async refreshUnsafe(): Promise<AgentJob[]> {
    const durable = await this.store.allJobs();
    const durableIds = new Set(durable.map(job => job.jobId));
    for (const cachedId of this.cache.jobs.keys()) if (!durableIds.has(cachedId)) this.cache.jobs.delete(cachedId);
    const jobs: AgentJob[] = [];
    for (const persisted of durable) {
      const job = this.withDerivedStatus(persisted);
      if (job.status !== persisted.status) await this.store.replaceState(job);
      this.cache.jobs.set(job.jobId, job);
      jobs.push(job);
    }
    return jobs;
  }

  /** Reconciliation-only read, used to establish the readiness gate itself. */
  async jobsBeforeReady(): Promise<AgentJob[]> { return this.refreshUnsafe(); }
  async refresh(): Promise<AgentJob[]> { await this.ready(); return this.refreshUnsafe(); }
  async jobs(): Promise<AgentJob[]> { return this.refresh(); }
  async job(jobId: string): Promise<AgentJob | undefined> { await this.refresh(); return this.cache.jobs.get(jobId); }
  /** Write-side lookup. Lifecycle writes must not wait for boot reconciliation. */
  async jobForWrite(jobId: string): Promise<AgentJob | undefined> {
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

  async create(job: AgentJob): Promise<AgentJob> {
    const next = this.withDerivedStatus(job); await this.store.insertJob(next); this.cache.jobs.set(next.jobId, next); this.emitChange(); return next;
  }

  async update(jobId: string, mutate: (current: AgentJob) => AgentJob): Promise<AgentJob | undefined> {
    const current = await this.jobForWrite(jobId); if (!current) return undefined;
    const next = this.withDerivedStatus(mutate(structuredClone(current))); await this.commit(next); return next;
  }

  async transition(jobId: string, taskIndex: number, patch: Partial<AgentJobTask>, jobPatch: Partial<AgentJob> = {}): Promise<AgentJob | undefined> {
    return this.update(jobId, current => ({ ...current, ...jobPatch, tasks: current.tasks.map((task, index) => index === taskIndex ? { ...task, ...patch } : task) }));
  }

  async transitionIfActivityUnchanged(jobId: string, taskIndex: number, observedActivity: number | null, patch: Partial<AgentJobTask>, jobPatch: Partial<AgentJob>): Promise<boolean> {
    const current = (await this.jobsBeforeReady()).find(job => job.jobId === jobId); if (!current?.tasks[taskIndex]) return false;
    const next = this.withDerivedStatus({ ...current, ...jobPatch, tasks: current.tasks.map((task, index) => index === taskIndex ? { ...task, ...patch } : task) });
    if (!await this.store.replaceStateIfActivityUnchanged(next, taskIndex, observedActivity)) return false;
    this.cache.jobs.set(next.jobId, next); this.emitChange(); return true;
  }

  async stopCascade(jobId: string): Promise<string[]> {
    const stoppedIds = await this.store.stopCascade(jobId); if (stoppedIds.length === 0) return [];
    const durable = await this.store.allJobs();
    for (const job of durable) if (stoppedIds.includes(job.jobId)) this.cache.jobs.set(job.jobId, this.withDerivedStatus(job));
    this.emitChange(); return stoppedIds;
  }

  touch(): void { this.emitChange(); }
  async commit(job: AgentJob): Promise<void> {
    const next = this.withDerivedStatus(job);
    try { await this.store.replaceState(next); this.cache.jobs.set(next.jobId, next); this.emitChange(); }
    finally { this.pendingTerminalWrites.delete(next.jobId); }
  }

  private withDerivedStatus(job: AgentJob): AgentJob {
    if (job.tasks.length === 0) return job;
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
