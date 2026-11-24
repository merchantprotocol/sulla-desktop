// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';

import type { AgentJobTaskTarget } from '../../database/models/AgentJobMessagingModel';

export interface PublishApprovalContext {
  threadId: string;
  channel: string;
  requestedBy?: { agentId: string; label?: string; jobId: string; taskIndex: number };
}

interface ThreadTaskReader {
  taskForThread(threadId: string): Promise<AgentJobTaskTarget | null>;
}

/** Resolves a delegated caller to the visible chat at the top of its persisted ancestry. */
export class PublishApprovalContextResolver {
  constructor(private readonly tasks: ThreadTaskReader = AgentJobMessagingModel) {}

  async resolve(threadId: string, channel: string): Promise<PublishApprovalContext> {
    const requester = await this.tasks.taskForThread(threadId);
    const requestedBy = requester?.agentId
      ? { agentId: requester.agentId, label: requester.label, jobId: requester.jobId, taskIndex: requester.taskIndex }
      : undefined;
    const visited = new Set([threadId]);
    let rootThreadId = threadId;
    let rootChannel = channel;
    let task = requester;
    while (task?.parentThreadId && !visited.has(task.parentThreadId)) {
      rootThreadId = task.parentThreadId;
      rootChannel = task.parentChannel || rootChannel;
      visited.add(rootThreadId);
      task = await this.tasks.taskForThread(rootThreadId);
    }
    return { threadId: rootThreadId, channel: rootChannel, ...(requestedBy ? { requestedBy } : {}) };
  }
}
