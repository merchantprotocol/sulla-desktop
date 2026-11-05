// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentTaskWaitRepository } from '../app/Repositories/AgentTaskWaitRepository';
import { postgresClient } from '../database/PostgresClient';
import { parkJobTask, getJob } from '../tools/agents/jobRegistry';
import { AgentTaskParkingService } from './AgentTaskParkingService';
import { AgentWakeScheduler } from './AgentWakeScheduler';

export const agentTaskWaitRepository = new AgentTaskWaitRepository(postgresClient);
export const agentWakeScheduler = new AgentWakeScheduler(agentTaskWaitRepository, async(wait) => {
  const job = await getJob(wait.jobId);
  const task = job?.tasks[wait.taskIndex];
  if (!job || !task?.threadId || task.status !== 'parked') return;
  const { getBackendGraphWebSocketService } = await import('./BackendGraphWebSocketService');
  await getBackendGraphWebSocketService().wakeParkedAgent(job.parentChannel ?? 'sulla-desktop', task.threadId,
    `[Wait complete]\n${ wait.reason }`, task.agentId, { jobId: wait.jobId, taskIndex: wait.taskIndex, source: 'agent_wait_timer' });
});
export const agentTaskParkingService = new AgentTaskParkingService(agentTaskWaitRepository, parkJobTask, agentWakeScheduler);
