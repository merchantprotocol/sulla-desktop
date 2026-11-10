// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentStateService } from './AgentStateService';
import type { AgentTaskActivityCheckin, AgentTaskActivityProjector } from './AgentTaskActivityProjector';
import { AgentJobLivenessPolicy } from '../../services/AgentJobLivenessPolicy';
export interface AgentLivenessProbe { graph(task: AgentJobTask): boolean; container(task: AgentJobTask): Promise<boolean | undefined>; lastCheckin(jobId: string, taskIndex: number): Promise<number | null>; }
export interface AgentLivenessConfig { quietAfterMs: number; lostAfterMs: number; intervalMs: number; }
const DEFAULT_CONFIG: AgentLivenessConfig = { quietAfterMs: 5 * 60_000, lostAfterMs: 2 * 60 * 60_000, intervalMs: 30_000 };

/** Eager and periodic repair of durable rows that no longer have a live run. */
export class AgentLivenessReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<number>;
  private readonly config: AgentLivenessConfig;
  private readonly policy: AgentJobLivenessPolicy;
  private readinessRecovery?: { isReady(): boolean; retryNow(): Promise<void> };
  constructor(private readonly states: AgentStateService, private readonly probe: AgentLivenessProbe,
    private readonly activity: AgentTaskActivityProjector,
    private readonly clock: () => number = Date.now, config: Partial<AgentLivenessConfig> = {}, policy = new AgentJobLivenessPolicy()) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.policy = policy;
    if (this.config.lostAfterMs <= this.config.quietAfterMs) throw new Error('lostAfterMs must be greater than quietAfterMs');
  }
  setReadinessRecovery(recovery: { isReady(): boolean; retryNow(): Promise<void> }): void { this.readinessRecovery = recovery; }
  reconcile(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const run = this.reconcileOnce().finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }
  private async reconcileOnce(): Promise<number> {
    if (this.readinessRecovery && !this.readinessRecovery.isReady()) void this.readinessRecovery.retryNow();
    let lost = 0;
    const jobs = await this.states.jobsBeforeReady();
    for (const job of jobs) for (const [taskIndex, task] of job.tasks.entries()) {
      if (!['queued', 'running', 'parked', 'blocked'].includes(task.status)) continue;
      const isTab = job.visibility === 'tab' || task.visibility === 'tab' || task.promotedToTab === true;
      // Parked includes agents/wait with a durable future wake. It is an
      // intentional dormant lifecycle state, not evidence of a lost runtime.
      if (isTab || task.status === 'parked' || (task.wakeAt !== undefined && task.wakeAt > this.clock())) continue;
      const containerLive = await this.probe.container(task);
      // Unknown means the runtime supervisor is still rebuilding bindings after
      // restart. Its bounded grace protects only the lost decision, never reads.
      if (this.probe.graph(task) || containerLive !== false) continue;
      const checkinAt = await this.probe.lastCheckin(job.jobId, taskIndex);
      const checkin: AgentTaskActivityCheckin | null = checkinAt === null ? null : { createdAt: checkinAt };
      // The shared projector includes task-scoped RunActivity (jobId#taskIndex),
      // so an active model/tool turn protects this task even with stale durable timestamps.
      const lastActivityAt = this.activity.project(job, task, taskIndex, checkin).lastActivityAt;
      if (!this.policy.isLost({ createdAt: job.createdAt, startedAt: task.startedAt ?? job.createdAt,
        lastActivityAt, hasCheckin: checkinAt !== null, now: this.clock(), hasLiveGraph: false,
        isTab, isParked: task.status === 'parked' || (task.wakeAt !== undefined && task.wakeAt > this.clock()),
        lostAfterMs: this.config.lostAfterMs })) continue;
      // RunActivity is process-local and intentionally absent from the repository CAS.
      // Re-read it at transition eligibility, then give Postgres only the durable
      // baseline it can compare. A concurrent durable check-in still defeats the CAS.
      const latestCheckinAt = await this.probe.lastCheckin(job.jobId, taskIndex);
      const latestCheckin: AgentTaskActivityCheckin | null = latestCheckinAt === null ? null : { createdAt: latestCheckinAt };
      const latestActivityAt = this.activity.project(job, task, taskIndex, latestCheckin).lastActivityAt;
      if (!this.policy.isLost({ createdAt: job.createdAt, startedAt: task.startedAt ?? job.createdAt,
        lastActivityAt: latestActivityAt, hasCheckin: latestCheckinAt !== null, now: this.clock(),
        hasLiveGraph: this.probe.graph(task), isTab, isParked: task.status === 'parked'
          || (task.wakeAt !== undefined && task.wakeAt > this.clock()), lostAfterMs: this.config.lostAfterMs })) continue;
      // The repository CAS compares the latest durable check-in, then the
      // task start, then the job creation time. Keep this exact nullish
      // precedence; max() would make a newer task start mask an older check-in
      // that Postgres can still observe.
      const durableActivityAt = latestCheckinAt ?? task.startedAt ?? job.createdAt;
      const reason = `lost: no live graph or container and no activity for ${ this.config.lostAfterMs }ms`;
      const finishedAt = this.clock();
      // TODO(F-1): switch to persisted 'lost' once F-1 merges.
      if (await this.states.transitionIfActivityUnchanged(job.jobId, taskIndex, durableActivityAt,
        { status: 'error', summary: reason, finishedAt }, { error: reason, finishedAt, waitingOnChildren: 0 },
        (current, candidate) => {
          const currentTask = current.tasks[taskIndex];
          if (!currentTask || !['queued', 'running', 'blocked'].includes(currentTask.status)) return false;
          if (currentTask.wakeAt !== undefined && currentTask.wakeAt > this.clock()) return false;
          const currentActivity = this.activity.project(current, currentTask, taskIndex, latestCheckin).lastActivityAt;
          return this.clock() - currentActivity >= this.config.lostAfterMs && candidate.tasks[taskIndex]?.status === 'error';
        })) lost++;
    }
    return lost;
  }
  start(): void { this.stop(); this.timer = setInterval(() => {
    void this.reconcile().catch(error => console.error('[AgentLivenessReconciler] reconciliation failed:', error));
  }, this.config.intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
