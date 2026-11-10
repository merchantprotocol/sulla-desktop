// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolExecutionContext } from '../executionContext';
import { ConversationBindingRecorder } from '../../channels/ConversationBindingRecorder';
import type { ConversationBindingRepository } from '../../channels/types';
import { PostgresConversationBindingRepository } from '../../app/Repositories/PostgresConversationBindingRepository';

export interface OutboundSlackMessage { account: string; teamId: string; channel: string; ts: string; threadTs: string | null; executionContext?: ToolExecutionContext; }
export interface SlackOutboundMessageObserverContract { onSent(message: OutboundSlackMessage): Promise<void> | void; }
export class OutboundSlackMessageObserver implements SlackOutboundMessageObserverContract {
  private readonly recorder: ConversationBindingRecorder;
  constructor(repository: ConversationBindingRepository = new PostgresConversationBindingRepository()) { this.recorder = new ConversationBindingRecorder(repository); }
  async onSent(message: OutboundSlackMessage): Promise<void> {
    const claims = message.executionContext;
    const target = claims?.thread_id
      ? { kind: 'chat' as const, threadId: claims.thread_id }
      : claims?.job_id && claims.agent_id
        ? { kind: 'job' as const, jobId: claims.job_id, ...(typeof claims.task_index === 'number' ? { taskIndex: claims.task_index } : {}) }
        : null;
    if (!target) return;
    await this.recorder.recordOutbound({ channel: 'slack', workspaceId: message.teamId, conversationId: message.channel,
      threadKey: message.threadTs || message.ts, target, agentId: claims?.agent_id });
  }
}
export class NoopOutboundSlackMessageObserver implements SlackOutboundMessageObserverContract { onSent(_message: OutboundSlackMessage): void {} }
