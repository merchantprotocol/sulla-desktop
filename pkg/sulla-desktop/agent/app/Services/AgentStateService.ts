// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentStateStore { allJobs(): Promise<AgentJob[]>; replaceState(job: AgentJob): Promise<void>; }
export interface AgentStateCache { jobs: Map<string, AgentJob>; }
export type AgentStateChangeListener = (version: number) => void;

/** Atomic write-through owner for durable and process-local agent state. */
export class AgentStateService {
  private versionValue: number;
  private readonly changes = new EventEmitter();

  constructor(private readonly store: AgentStateStore, private readonly cache: AgentStateCache, now: () => number = Date.now) {
    this.versionValue = now();
  }

  get version(): number { return this.versionValue; }
  onChange(listener: AgentStateChangeListener): () => void {
    this.changes.on('change', listener);
    return () => this.changes.off('change', listener);
  }

  async refresh(): Promise<AgentJob[]> {
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

  async jobs(): Promise<AgentJob[]> { return this.refresh(); }
  async job(jobId: string): Promise<AgentJob | undefined> { await this.refresh(); return this.cache.jobs.get(jobId); }

  async descendants(parentThreadId: string): Promise<AgentJob[]> {
    const jobs = await this.jobs();
    const threadIds = new Set([parentThreadId]);
    const descendants: AgentJob[] = [];
    let added = true;
    while (added) {
      added = false;
      for (const job of jobs) {
        if (descendants.includes(job) || !job.parentThreadId || !threadIds.has(job.parentThreadId)) continue;
        descendants.push(job);
        for (const task of job.tasks) if (task.threadId) threadIds.add(task.threadId);
        added = true;
      }
    }
    return descendants.sort((a, b) => a.createdAt - b.createdAt);
  }

  async list(limit = 25, includeFinished = true): Promise<AgentJob[]> {
    const jobs = (await this.jobs()).filter(job => !job.dismissedAt);
    const active = jobs.filter(job => ['running', 'parked'].includes(job.status));
    if (!includeFinished) return active.sort((a, b) => b.createdAt - a.createdAt);
    const terminal = jobs.filter(job => !['running', 'parked'].includes(job.status))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.min(100, Math.max(1, limit)));
    return [...active, ...terminal].sort((a, b) => b.createdAt - a.createdAt);
  }

  isLive(job: AgentJob, task: AgentJobTask): boolean {
    return ['running', 'parked'].includes(job.status) && ['queued', 'running', 'parked', 'blocked'].includes(task.status);
  }

  async transition(jobId: string, taskIndex: number, patch: Partial<AgentJobTask>, jobPatch: Partial<AgentJob> = {}): Promise<AgentJob | undefined> {
    const current = await this.job(jobId);
    if (!current?.tasks[taskIndex]) return undefined;
    const tasks = current.tasks.map((task, index) => index === taskIndex ? { ...task, ...patch } : task);
    const next = this.withDerivedStatus({ ...current, ...jobPatch, tasks });
    await this.commit(next);
    return next;
  }

  touch(): void { this.emitChange(); }

  async commit(job: AgentJob): Promise<void> {
    const next = this.withDerivedStatus(job);
    await this.store.replaceState(next);
    this.cache.jobs.set(next.jobId, next);
    this.emitChange();
  }

  private withDerivedStatus(job: AgentJob): AgentJob {
    if (job.tasks.length === 0) return job;
    const statuses = job.tasks.map(task => task.status);
    let status: AgentJob['status'];
    if (statuses.some(taskStatus => taskStatus === 'error')) status = 'failed';
    else if (statuses.some(taskStatus => ['queued', 'running', 'blocked'].includes(taskStatus))) status = 'running';
    else if (statuses.some(taskStatus => taskStatus === 'parked')) status = 'parked';
    else if (statuses.every(taskStatus => taskStatus === 'stopped')) status = 'stopped';
    else status = 'completed';
    return status === job.status ? job : { ...job, status };
  }

  private emitChange(): void {
    this.versionValue = Math.max(this.versionValue + 1, Date.now());
    this.changes.emit('change', this.versionValue);
  }
}
