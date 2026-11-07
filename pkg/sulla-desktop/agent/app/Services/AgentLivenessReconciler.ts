// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentStateService } from './AgentStateService';
import type { AgentTaskActivityCheckin, AgentTaskActivityProjector } from './AgentTaskActivityProjector';
export interface AgentLivenessProbe { graph(task: AgentJobTask): boolean; container(task: AgentJobTask): Promise<boolean | undefined>; lastCheckin(jobId: string, taskIndex: number): Promise<number | null>; }
export interface AgentLivenessConfig { quietAfterMs: number; lostAfterMs: number; intervalMs: number; }
const DEFAULT_CONFIG: AgentLivenessConfig = { quietAfterMs: 5 * 60_000, lostAfterMs: 15 * 60_000, intervalMs: 30_000 };

/** Eager and periodic repair of durable rows that no longer have a live run. */
export class AgentLivenessReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly config: AgentLivenessConfig;
  private readinessRecovery?: { isReady(): boolean; retryNow(): Promise<void> };
  constructor(private readonly states: AgentStateService, private readonly probe: AgentLivenessProbe,
    private readonly activity: AgentTaskActivityProjector,
    private readonly clock: () => number = Date.now, config: Partial<AgentLivenessConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.lostAfterMs <= this.config.quietAfterMs) throw new Error('lostAfterMs must be greater than quietAfterMs');
  }
  setReadinessRecovery(recovery: { isReady(): boolean; retryNow(): Promise<void> }): void { this.readinessRecovery = recovery; }
  async reconcile(): Promise<number> {
    if (this.readinessRecovery && !this.readinessRecovery.isReady()) void this.readinessRecovery.retryNow();
    let lost = 0;
    const jobs = await this.states.jobsBeforeReady();
    for (const job of jobs) for (const [taskIndex, task] of job.tasks.entries()) {
      if (!['queued', 'running', 'parked', 'blocked'].includes(task.status)) continue;
      // Parked includes agents/wait with a durable future wake. It is an
      // intentional dormant lifecycle state, not evidence of a lost runtime.
      if (task.status === 'parked' || (task.wakeAt !== undefined && task.wakeAt > this.clock())) continue;
      const containerLive = await this.probe.container(task);
      // Unknown means the runtime supervisor is still rebuilding bindings after
      // restart. Its bounded grace protects only the lost decision, never reads.
      if (this.probe.graph(task) || containerLive !== false) continue;
      const checkinAt = await this.probe.lastCheckin(job.jobId, taskIndex);
      const checkin: AgentTaskActivityCheckin | null = checkinAt === null ? null : { createdAt: checkinAt };
      // The shared projector includes task-scoped RunActivity (jobId#taskIndex),
      // so an active model/tool turn protects this task even with stale durable timestamps.
      const lastActivityAt = this.activity.project(job, task, taskIndex, checkin).lastActivityAt;
      if (this.clock() - lastActivityAt < this.config.lostAfterMs) continue;
      // RunActivity is process-local and intentionally absent from the repository CAS.
      // Re-read it at transition eligibility, then give Postgres only the durable
      // baseline it can compare. A concurrent durable check-in still defeats the CAS.
      const latestCheckinAt = await this.probe.lastCheckin(job.jobId, taskIndex);
      const latestCheckin: AgentTaskActivityCheckin | null = latestCheckinAt === null ? null : { createdAt: latestCheckinAt };
      if (this.clock() - this.activity.project(job, task, taskIndex, latestCheckin).lastActivityAt < this.config.lostAfterMs) continue;
      const durableActivityAt = Math.max(task.startedAt ?? job.createdAt, latestCheckinAt ?? 0);
      const reason = `lost: no live graph or container and no activity for ${ this.config.lostAfterMs }ms`;
      const finishedAt = this.clock();
      // TODO(F-1): switch to persisted 'lost' once F-1 merges.
      if (await this.states.transitionIfActivityUnchanged(job.jobId, taskIndex, durableActivityAt,
        { status: 'error', summary: reason, finishedAt }, { error: reason, finishedAt, waitingOnChildren: 0 })) lost++;
    }
    return lost;
  }
  start(): void { this.stop(); this.timer = setInterval(() => void this.reconcile(), this.config.intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
