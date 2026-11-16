// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentTaskWaitRepository } from '../app/Repositories/AgentTaskWaitRepository';
import type { AgentWaitRequest } from './AgentWaitRequest';
import type { AgentWakeScheduler } from './AgentWakeScheduler';

interface ParkableJob { waitingOnChildren?: number; tasks: Array<{ status: string; waitReason?: string; wakeAt?: number }> }

export class AgentTaskParkingService {
  /**
   * The job with this task parked on a timed wait, or undefined when the task
   * is settled. agents/wait only runs inside a live turn, so a row still
   * marked 'parked' (its child park or an earlier wait, woken by an injected
   * steer) is stale and may be re-parked; refusing it told live managers their
   * task was "no longer running".
   */
  static parkedJob<J extends ParkableJob>(current: J, wait: { taskIndex: number; reason: string; wakeAt: Date }): J | undefined {
    const status = current.tasks[wait.taskIndex]?.status;
    if (status !== 'running' && status !== 'parked') return undefined;
    return { ...current, waitingOnChildren: 0,
      tasks: current.tasks.map((task, index) => index === wait.taskIndex
        ? { ...task, status: 'parked', waitReason: wait.reason, wakeAt: wait.wakeAt.getTime() } : task) };
  }

  constructor(private readonly waits: AgentTaskWaitRepository, private readonly parkTask: (wait: AgentTaskWaitRepository extends never ? never : { jobId: string; taskIndex: number; reason: string; wakeAt: Date }) => Promise<boolean>, private readonly scheduler: AgentWakeScheduler) {}

  async park(jobId: string, taskIndex: number, request: AgentWaitRequest): Promise<void> {
    const wait = { jobId, taskIndex, wakeAt: request.wakeAt, reason: request.reason, state: 'scheduled' as const };
    await this.waits.schedule(wait);
    if (!await this.parkTask(wait)) {
      await this.waits.cancel(jobId, taskIndex);
      throw new Error('The delegated task is no longer running and cannot be parked.');
    }
    this.scheduler.schedule(wait);
  }
}
