// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import type { AgentStateService } from './AgentStateService';
export interface AgentLivenessProbe { graph(task: AgentJobTask): boolean; container(task: AgentJobTask): Promise<boolean>; lastCheckin(jobId: string, taskIndex: number): Promise<number | null>; }

/** Eager and periodic repair of durable rows that no longer have a live run. */
export class AgentLivenessReconciler {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly states: AgentStateService, private readonly probe: AgentLivenessProbe,
    private readonly clock: () => number = Date.now, private readonly staleAfterMs = 180_000) {}
  async reconcile(): Promise<number> {
    let lost = 0;
    for (const job of await this.states.jobs()) for (const [taskIndex, task] of job.tasks.entries()) {
      if (!['queued', 'running', 'parked', 'blocked'].includes(task.status)) continue;
      const hasLiveChildren = task.status === 'parked' && task.threadId
        ? (await this.states.jobs()).some(child => child.parentThreadId === task.threadId && ['running', 'parked'].includes(child.status)) : false;
      if (hasLiveChildren || this.probe.graph(task) || await this.probe.container(task)) continue;
      const checkinAt = await this.probe.lastCheckin(job.jobId, taskIndex);
      const immediatelyStale = task.status === 'queued' && !task.startedAt;
      if (!immediatelyStale && checkinAt && this.clock() - checkinAt <= this.staleAfterMs) continue;
      const reason = 'lost: no live graph or container and no recent check-in';
      const finishedAt = this.clock();
      await this.states.transition(job.jobId, taskIndex, { status: 'error', summary: reason, finishedAt },
        { status: 'failed', error: reason, finishedAt, waitingOnChildren: 0 });
      lost++;
    }
    return lost;
  }
  start(intervalMs = 30_000): void { this.stop(); this.timer = setInterval(() => void this.reconcile(), intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
