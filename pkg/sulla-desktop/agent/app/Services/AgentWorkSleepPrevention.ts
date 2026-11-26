// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../../tools/agents/jobRegistry';
import type { AgentStateService } from './AgentStateService';

export const AGENT_WORK_CAFFEINATE_KEY = 'agent-work';

export interface CaffeinateHold {
  startCaffeinate(key: string): void;
  stopCaffeinate(key: string): void;
}

/** Maintains one keyed system-sleep hold while any delegated task or chat run is active. */
export class AgentWorkSleepPrevention {
  private readonly activeJobs = new Set<string>();
  private readonly activeChatRuns = new Set<string>();
  private pendingSnapshotChanges?: Map<string, boolean>;
  private reconciliation?: Promise<void>;
  private held = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly states: Pick<AgentStateService, 'onJobChange' | 'refreshLive'>,
    private readonly caffeinate: CaffeinateHold,
    private readonly holdKey = AGENT_WORK_CAFFEINATE_KEY,
  ) {
    this.unsubscribe = states.onJobChange((_previous, next) => this.jobChanged(next));
  }

  /** Rebuild process-local job state once startup recovery has finished. */
  reconcileAfterRecovery(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const reconciliation = this.reconcileJobs();
    this.reconciliation = reconciliation.finally(() => { this.reconciliation = undefined });
    return this.reconciliation;
  }

  chatRunStarted(key: string): void {
    if (!key || this.activeChatRuns.has(key)) return;
    this.activeChatRuns.add(key);
    this.syncHold();
  }

  chatRunEnded(key: string): void {
    if (!this.activeChatRuns.delete(key)) return;
    this.syncHold();
  }

  dispose(): void {
    this.unsubscribe();
    this.activeJobs.clear();
    this.activeChatRuns.clear();
    this.syncHold();
  }

  private async reconcileJobs(): Promise<void> {
    const pending = new Map<string, boolean>();
    this.pendingSnapshotChanges = pending;
    try {
      const jobs = await this.states.refreshLive();
      const active = new Set(jobs.filter(job => this.hasRunningWork(job)).map(job => job.jobId));
      for (const [jobId, isActive] of pending) this.setJobState(active, jobId, isActive);
      this.activeJobs.clear();
      for (const jobId of active) this.activeJobs.add(jobId);
    } finally {
      if (this.pendingSnapshotChanges === pending) this.pendingSnapshotChanges = undefined;
      this.syncHold();
    }
  }

  private jobChanged(job: AgentJob): void {
    const isActive = this.hasRunningWork(job);
    this.setJobState(this.activeJobs, job.jobId, isActive);
    this.pendingSnapshotChanges?.set(job.jobId, isActive);
    this.syncHold();
  }

  private hasRunningWork(job: AgentJob): boolean {
    return job.status === 'running' || job.tasks.some(task => task.status === 'running');
  }

  private setJobState(jobs: Set<string>, jobId: string, active: boolean): void {
    if (active) jobs.add(jobId);
    else jobs.delete(jobId);
  }

  private syncHold(): void {
    const shouldHold = this.activeJobs.size > 0 || this.activeChatRuns.size > 0;
    if (shouldHold === this.held) return;
    this.held = shouldHold;
    if (shouldHold) this.caffeinate.startCaffeinate(this.holdKey);
    else this.caffeinate.stopCaffeinate(this.holdKey);
  }
}
