// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { AgentJobTaskTarget } from '../database/models/AgentJobMessagingModel';
import type { PendingCompletion } from './AgentCompletionInbox';
import { AgentAwarenessPolicy } from './AgentAwarenessPolicy';

export interface DecisionParentFyiMailbox {
  channel: string;
  threadId: string;
  seesOtherAgents: boolean;
  task?: AgentJobTaskTarget;
}

export interface DecisionParentFyiDelivery {
  askerForThread(threadId: string): Promise<AgentJobTaskTarget | null>;
  parentMailbox(asker: AgentJobTaskTarget): Promise<DecisionParentFyiMailbox | null>;
  queueAgentMessage(target: AgentJobTaskTarget, message: string): Promise<void>;
  enqueueChatQuietly(channel: string, threadId: string, entry: PendingCompletion): boolean | Promise<boolean>;
}

/** Best-effort, non-waking heads-up for a delegated request that only a human may settle. */
export class DecisionParentFyiNotifier {
  private readonly attemptedDecisionIds = new Set<string>();

  constructor(private readonly delivery: DecisionParentFyiDelivery = new RuntimeDecisionParentFyiDelivery()) {}

  async notify(record: DecisionRecord): Promise<void> {
    if (!this.isHumanOnly(record) || this.attemptedDecisionIds.has(record.id)) return;
    this.attemptedDecisionIds.add(record.id);
    try {
      const asker = await this.delivery.askerForThread(record.conversationId);
      if (!asker || !this.isLive(asker) || !asker.parentChannel || !asker.parentThreadId) return;
      const parent = await this.delivery.parentMailbox(asker);
      if (!parent?.seesOtherAgents) return;
      const notice = this.notice(record, asker);
      if (parent.task) {
        await this.delivery.queueAgentMessage(parent.task, notice);
      } else {
        await this.delivery.enqueueChatQuietly(parent.channel, parent.threadId, {
          jobId: record.id,
          taskIndex: record.route?.holderIndex ?? 0,
          results: [],
          notice,
          dedupeKey: `decision:${ record.id }:parent-fyi`,
        });
      }
    } catch { /* An FYI failure never changes or blocks the human decision. */ }
  }

  private isHumanOnly(record: DecisionRecord): boolean {
    return record.kind === 'approval' || (record.kind === 'question' && record.route?.authority === 'human');
  }

  private isLive(target: AgentJobTaskTarget): boolean {
    return ['running', 'parked'].includes(target.jobStatus) && ['running', 'parked'].includes(target.taskStatus);
  }

  private notice(record: DecisionRecord, asker: AgentJobTaskTarget): string {
    const sender = this.singleLine(record.requestedBy?.label || record.requestedBy?.agentId || asker.label || asker.agentId || 'agent', 100);
    const title = this.singleLine(record.title || 'request', 300);
    return `[FYI from ${ sender }] asked the human to approve: ${ title }. No action needed; you cannot approve it.`;
  }

  private singleLine(value: string, limit: number): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || 'request';
  }
}

class RuntimeDecisionParentFyiDelivery implements DecisionParentFyiDelivery {
  private readonly awarenessPolicy = new AgentAwarenessPolicy();

  async askerForThread(threadId: string): Promise<AgentJobTaskTarget | null> {
    const { AgentJobMessagingModel } = await import('../database/models/AgentJobMessagingModel');
    return AgentJobMessagingModel.taskForThread(threadId);
  }

  async parentMailbox(asker: AgentJobTaskTarget): Promise<DecisionParentFyiMailbox | null> {
    const parentThreadId = asker.parentThreadId;
    const channel = asker.parentChannel;
    if (!parentThreadId || !channel) return null;

    const { GraphRegistry } = await import('./GraphRegistry');
    const parentGraph = GraphRegistry.get(parentThreadId);
    const { AgentJobMessagingModel } = await import('../database/models/AgentJobMessagingModel');
    const task = await AgentJobMessagingModel.taskForThread(parentThreadId);
    if (task && (!['running', 'parked'].includes(task.jobStatus) || !['running', 'parked'].includes(task.taskStatus))) return null;
    if (!task && !parentGraph) return null;

    const runtimeAwareness = parentGraph?.state?.metadata?.agentAwareness;
    let setting: { agent_awareness?: boolean | null; agentAwareness?: boolean | null } | null =
      typeof runtimeAwareness === 'boolean' ? { agent_awareness: runtimeAwareness } : null;
    const parentAgentId = task?.agentId || parentGraph?.state?.metadata?.agentId;
    if (typeof runtimeAwareness !== 'boolean' && parentAgentId) {
      const { agentDefinitionService } = await import('./AgentDefinitionService');
      setting = await agentDefinitionService.findBySlug(String(parentAgentId));
    }
    return {
      channel,
      threadId: parentThreadId,
      seesOtherAgents: this.awarenessPolicy.canSeeOtherAgents(setting),
      ...(task ? { task } : {}),
    };
  }

  async queueAgentMessage(target: AgentJobTaskTarget, message: string): Promise<void> {
    const { AgentJobMessagingModel } = await import('../database/models/AgentJobMessagingModel');
    await AgentJobMessagingModel.queueMessage(target, message);
  }

  async enqueueChatQuietly(channel: string, threadId: string, entry: PendingCompletion): Promise<boolean> {
    const { enqueueAgentCompletionQuietly } = await import('./AgentCompletionInbox');
    return enqueueAgentCompletionQuietly(channel, threadId, entry);
  }
}
