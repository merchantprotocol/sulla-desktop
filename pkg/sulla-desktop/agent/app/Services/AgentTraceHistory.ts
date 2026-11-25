// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentJobCheckin, AgentJobMessage } from '../../database/models/AgentJobMessagingModel';
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentTraceHistoryData {
  checkins: readonly AgentJobCheckin[];
  /** Messages sent to the worker while it ran (agent_job_messages), shown among its check-ins. */
  messages: readonly Pick<AgentJobMessage, 'message' | 'createdAt'>[];
  runLocation?: 'vm' | 'container';
}

/** Read only check-ins and messages for a task launched by the exact transcript requesting them. */
export class AgentTraceHistory {
  constructor(
    private readonly jobs: { job(id: string): Promise<(Pick<AgentJob, 'parentThreadId'> & { tasks: readonly Pick<AgentJobTask, 'runLocation'>[] }) | undefined> },
    private readonly messaging: {
      checkinsForTask(jobId: string, taskIndex: number): Promise<AgentJobCheckin[]>;
      messagesForTask(jobId: string, taskIndex: number): Promise<AgentJobMessage[]>;
    },
  ) {}

  async get(parentThreadId: string, jobId: string, taskIndex: number): Promise<AgentTraceHistoryData | null> {
    if (typeof parentThreadId !== 'string' || !parentThreadId.trim() || parentThreadId.length > 512 ||
      typeof jobId !== 'string' || !jobId.trim() || jobId.length > 512 || !Number.isSafeInteger(taskIndex) || taskIndex < 0) return null;
    const job = await this.jobs.job(jobId);
    const task = job?.tasks[taskIndex];
    if (!task || job?.parentThreadId !== parentThreadId) return null;
    const [checkins, messages] = await Promise.all([
      this.messaging.checkinsForTask(jobId, taskIndex), this.messaging.messagesForTask(jobId, taskIndex),
    ]);
    return { checkins, messages: messages.map(({ message, createdAt }) => ({ message, createdAt })), runLocation: task.runLocation };
  }
}
