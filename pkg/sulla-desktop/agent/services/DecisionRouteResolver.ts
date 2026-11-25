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
    let current = requester;
    let parentThreadId = requester.parentThreadId;
    let parentChannel = requester.parentChannel || channel;

    while (parentThreadId && !visited.has(parentThreadId)) {
      visited.add(parentThreadId);
      const parent = await this.taskForThread(parentThreadId);
      if (!parent) {
        // A top-level chat has an agent and a human at the same thread. A
        // pruned parent job, in contrast, is not a live agent holder.
        if (current.parentJobId === null) {
          chain.push({ threadId: parentThreadId, channel: parentChannel, agentId: parentChannel || DecisionRouteResolver.UNNAMED_AGENT, kind: 'agent' });
        }
        chain.push(this.humanEntry(parentThreadId, parentChannel));
        return chain;
      }
      chain.push({
        threadId: parentThreadId,
        channel: parentChannel,
        agentId: parent.agentId || parent.label || DecisionRouteResolver.UNNAMED_AGENT,
        label: parent.label || undefined,
        jobId: parent.jobId,
        taskIndex: parent.taskIndex,
        ...(parent.spawnMode ? { spawnMode: parent.spawnMode } : {}),
        kind: 'agent',
      });
      parentThreadId = parent.parentThreadId;
      parentChannel = parent.parentChannel || parentChannel;
      current = parent;
    }

    // A corrupt cycle has no trustworthy root. Preserve the last distinct ancestor as the human fallback.
    if (parentThreadId && visited.has(parentThreadId)) {
      const last = chain[chain.length - 1];
      if (last) chain[chain.length - 1] = this.humanEntry(last.threadId, last.channel);
      else chain.push(this.humanEntry(conversationId, channel));
      return chain;
    }

    // A missing parent must never create a route with no human fallback.
    const rootThreadId = conversationId;
    if (chain[chain.length - 1]?.threadId !== rootThreadId || chain[chain.length - 1]?.kind !== 'human') {
      chain.push(this.humanEntry(rootThreadId, parentChannel));
    }
    return chain;
  }

  /** Missing, finished, stopped or pruned parent jobs are unavailable at advance time. */
  async liveness(entry: DecisionRouteEntry, askerThreadId?: string, chain?: DecisionRouteEntry[], holderIndex?: number): Promise<'available' | 'unavailable'> {
    if (entry.kind === 'human') return 'available';
    const child = holderIndex && holderIndex > 0 ? chain?.[holderIndex - 1] : undefined;
    const childTask = child?.kind === 'agent' ? await this.taskForThread(child.threadId)
      : askerThreadId ? await this.taskForThread(askerThreadId) : null;
    const childSpawnMode = child?.spawnMode ?? childTask?.spawnMode;
    if (childSpawnMode === 'sync') return 'unavailable';
    if (!entry.jobId) return 'available';
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
