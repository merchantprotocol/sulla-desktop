// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentJobCheckin } from '../../database/models/AgentJobMessagingModel';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentTraceHistoryData {
  checkins: readonly AgentJobCheckin[];
  runLocation?: 'vm' | 'container';
}

/** Read only check-ins for a task launched by the exact transcript requesting them. */
export class AgentTraceHistory {
  constructor(
    private readonly jobs: { job(id: string): Promise<(Pick<AgentJob, 'parentThreadId'> & { tasks: readonly Pick<AgentJobTask, 'runLocation'>[] }) | undefined> },
    private readonly messaging: { checkinsForTask(jobId: string, taskIndex: number): Promise<AgentJobCheckin[]> },
  ) {}

  async get(parentThreadId: string, jobId: string, taskIndex: number): Promise<AgentTraceHistoryData | null> {
    if (typeof parentThreadId !== 'string' || !parentThreadId.trim() || parentThreadId.length > 512 ||
      typeof jobId !== 'string' || !jobId.trim() || jobId.length > 512 || !Number.isSafeInteger(taskIndex) || taskIndex < 0) return null;
    const job = await this.jobs.job(jobId);
    const task = job?.tasks[taskIndex];
    if (!task || job?.parentThreadId !== parentThreadId) return null;
    return { checkins: await this.messaging.checkinsForTask(jobId, taskIndex), runLocation: task.runLocation };
  }
}
