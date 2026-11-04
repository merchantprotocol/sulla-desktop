// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentStateStore {
  allJobs(): Promise<AgentJob[]>;
  replaceState(job: AgentJob): Promise<void>;
}
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
    const jobs = await this.store.allJobs();
    for (const job of jobs) this.cache.jobs.set(job.jobId, job);
    return jobs;
  }

  async jobs(): Promise<AgentJob[]> { await this.refresh(); return Array.from(this.cache.jobs.values()); }
  async job(jobId: string): Promise<AgentJob | undefined> { await this.refresh(); return this.cache.jobs.get(jobId); }

  isLive(job: AgentJob, task: AgentJobTask): boolean {
    return ['running', 'parked'].includes(job.status) && ['queued', 'running', 'parked', 'blocked'].includes(task.status);
  }

  async transition(jobId: string, taskIndex: number, patch: Partial<AgentJobTask>, jobPatch: Partial<AgentJob> = {}): Promise<AgentJob | undefined> {
    const current = await this.job(jobId);
    if (!current?.tasks[taskIndex]) return undefined;
    const tasks = current.tasks.map((task, index) => index === taskIndex ? { ...task, ...patch } : task);
    const next = { ...current, ...jobPatch, tasks };
    await this.commit(next);
    return next;
  }

  touch(): void {
    this.versionValue = Math.max(this.versionValue + 1, Date.now());
    this.changes.emit('change', this.versionValue);
  }

  async commit(job: AgentJob): Promise<void> {
    // The single UPDATE in replaceState writes the rollup and JSON task states
    // in one PostgreSQL transaction; cache changes only after it succeeds.
    await this.store.replaceState(job);
    this.cache.jobs.set(job.jobId, job);
    this.versionValue = Math.max(this.versionValue + 1, Date.now());
    this.changes.emit('change', this.versionValue);
  }
}
