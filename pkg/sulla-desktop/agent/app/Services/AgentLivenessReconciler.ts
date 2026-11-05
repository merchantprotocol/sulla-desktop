// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentStateService } from './AgentStateService';
export interface AgentLivenessProbe { graph(task: AgentJobTask): boolean; container(task: AgentJobTask): Promise<boolean>; lastCheckin(jobId: string, taskIndex: number): Promise<number | null>; }
export interface AgentLivenessConfig { quietAfterMs: number; lostAfterMs: number; intervalMs: number; }
const DEFAULT_CONFIG: AgentLivenessConfig = { quietAfterMs: 5 * 60_000, lostAfterMs: 15 * 60_000, intervalMs: 30_000 };

/** Eager and periodic repair of durable rows that no longer have a live run. */
export class AgentLivenessReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly config: AgentLivenessConfig;
  constructor(private readonly states: AgentStateService, private readonly probe: AgentLivenessProbe,
    private readonly clock: () => number = Date.now, config: Partial<AgentLivenessConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.lostAfterMs <= this.config.quietAfterMs) throw new Error('lostAfterMs must be greater than quietAfterMs');
  }
  async reconcile(): Promise<number> {
    let lost = 0;
    const jobs = await this.states.jobs();
    for (const job of jobs) for (const [taskIndex, task] of job.tasks.entries()) {
      if (!['queued', 'running', 'parked', 'blocked'].includes(task.status)) continue;
      const hasLiveChildren = task.status === 'parked' && task.threadId
        ? jobs.some(child => child.parentThreadId === task.threadId && ['running', 'parked'].includes(child.status)) : false;
      if (hasLiveChildren || this.probe.graph(task) || await this.probe.container(task)) continue;
      const checkinAt = await this.probe.lastCheckin(job.jobId, taskIndex);
      const lastActivityAt = checkinAt ?? task.startedAt ?? job.createdAt;
      if (this.clock() - lastActivityAt < this.config.lostAfterMs) continue;
      const reason = `lost: no live graph or container and no activity for ${ this.config.lostAfterMs }ms`;
      const finishedAt = this.clock();
      await this.states.transition(job.jobId, taskIndex, { status: 'lost', summary: reason, finishedAt },
        { error: reason, finishedAt, waitingOnChildren: 0 });
      lost++;
    }
    return lost;
  }
  start(): void { this.stop(); this.timer = setInterval(() => void this.reconcile(), this.config.intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
