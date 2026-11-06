// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentTaskWaitRepository } from '../app/Repositories/AgentTaskWaitRepository';
import { postgresClient } from '../database/PostgresClient';
import { getJob } from '../tools/agents/jobRegistry';
import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { AgentTaskParkingService } from './AgentTaskParkingService';
import { AgentWakeScheduler } from './AgentWakeScheduler';

/** Composition root for durable delegated-task waits. */
export class AgentWaitServiceProvider {
  readonly repository: AgentTaskWaitRepository;
  readonly scheduler: AgentWakeScheduler;
  readonly parking: AgentTaskParkingService;

  constructor() {
    this.repository = new AgentTaskWaitRepository(postgresClient);
    this.scheduler = new AgentWakeScheduler(this.repository, async(wait) => {
      const job = await getJob(wait.jobId);
      const task = job?.tasks[wait.taskIndex];
      if (!job || !task?.threadId || task.status !== 'parked') return;
      const { getBackendGraphWebSocketService } = await import('./BackendGraphWebSocketService');
      await getBackendGraphWebSocketService().wakeParkedAgent(job.parentChannel ?? 'sulla-desktop', task.threadId,
        `[Wait complete]\n${ wait.reason }`, task.agentId, { jobId: wait.jobId, taskIndex: wait.taskIndex, source: 'agent_wait_timer' });
    });
    this.parking = new AgentTaskParkingService(this.repository, async(wait) => Boolean(await agentJobProvider.states.mutateJob(wait.jobId, current =>
      current.tasks[wait.taskIndex]?.status === 'running' ? { ...current, waitingOnChildren: 0,
        tasks: current.tasks.map((task, index) => index === wait.taskIndex
          ? { ...task, status: 'parked', waitReason: wait.reason, wakeAt: wait.wakeAt.getTime() } : task) } : undefined)), this.scheduler);
  }

  async cancel(jobId: string, taskIndex: number): Promise<boolean> {
    const cancelled = await this.repository.cancel(jobId, taskIndex);
    this.scheduler.cancel(jobId, taskIndex);
    return cancelled;
  }
}

export const agentWaitProvider = new AgentWaitServiceProvider();
