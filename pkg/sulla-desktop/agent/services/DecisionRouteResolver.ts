// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentJobTaskTarget } from '../database/models/AgentJobMessagingModel';
import type { DecisionRouteEntry } from '@pkg/shared/decisions';

export interface DecisionRouteTaskReader {
  taskForThread?(threadId: string): Promise<AgentJobTaskTarget | null>;
}

/** Snapshots the ordered parent chain; liveness is deliberately re-read when an escalation advances. */
export class DecisionRouteResolver {
  private static readonly UNNAMED_AGENT = 'default agent';

  constructor(private readonly tasks: DecisionRouteTaskReader) {}

  async resolve(conversationId: string, channel: string): Promise<DecisionRouteEntry[]> {
    const requester = await this.taskForThread(conversationId);
    if (!requester) return [this.humanEntry(conversationId, channel)];

    const chain: DecisionRouteEntry[] = [];
    const visited = new Set([conversationId]);
    let parentThreadId = requester.parentThreadId;
    let parentChannel = requester.parentChannel || channel;

    while (parentThreadId && !visited.has(parentThreadId)) {
      visited.add(parentThreadId);
      const parent = await this.taskForThread(parentThreadId);
      if (!parent) {
        chain.push(this.humanEntry(parentThreadId, parentChannel));
        return chain;
      }
      chain.push({
        threadId: parentThreadId,
        channel: parentChannel,
        agentId: parent.agentId || parent.label || DecisionRouteResolver.UNNAMED_AGENT,
        jobId: parent.jobId,
        taskIndex: parent.taskIndex,
        kind: 'agent',
      });
      parentThreadId = parent.parentThreadId;
      parentChannel = parent.parentChannel || parentChannel;
    }

    // A missing parent or a corrupt cycle must never create a route with no human fallback.
    const rootThreadId = parentThreadId && visited.has(parentThreadId) ? parentThreadId : conversationId;
    if (chain[chain.length - 1]?.threadId !== rootThreadId || chain[chain.length - 1]?.kind !== 'human') {
      chain.push(this.humanEntry(rootThreadId, parentChannel));
    }
    return chain;
  }

  /** Missing, finished, stopped or pruned parent jobs are unavailable at advance time. */
  async liveness(entry: DecisionRouteEntry): Promise<'available' | 'unavailable'> {
    if (entry.kind === 'human') return 'available';
    const task = await this.taskForThread(entry.threadId);
    if (!task || task.jobId !== entry.jobId || task.taskIndex !== entry.taskIndex) return 'unavailable';
    return ['running', 'parked'].includes(task.jobStatus) && ['running', 'parked'].includes(task.taskStatus)
      ? 'available'
      : 'unavailable';
  }

  private humanEntry(threadId: string, channel: string): DecisionRouteEntry {
    return { threadId, channel, agentId: 'human', kind: 'human' };
  }

  private taskForThread(threadId: string): Promise<AgentJobTaskTarget | null> {
    return this.tasks.taskForThread?.(threadId) ?? Promise.resolve(null);
  }
}
