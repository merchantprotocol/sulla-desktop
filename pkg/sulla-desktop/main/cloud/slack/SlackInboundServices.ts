// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from 'crypto';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';
import { sendJobMessage } from '@pkg/agent/tools/agents/send_job_message';
import type { ChatChannelSender, JobChannelSender } from '@pkg/agent/channels/ChannelInboundDelivery';
import type { PersistentThreadFactory } from '@pkg/agent/channels/types';

/** Delivers chat messages through the same local graph websocket used by Desktop chat. */
export class LocalSlackChatSender implements ChatChannelSender {
  constructor(private readonly bus = getWebSocketClientService()) {}

  async send(threadId: string, content: string, metadata: Record<string, string>): Promise<void> {
    const accepted = await this.bus.send('sulla-desktop', {
      type: 'user_message',
      data: { content, threadId, metadata },
      timestamp: Date.now(),
    });
    if (!accepted) throw new Error('Slack chat delivery was not accepted');
  }
}

/** Delegates job-target delivery to the existing durable agent-job messaging path. */
export class ExistingSlackJobSender implements JobChannelSender {
  constructor(private readonly sendMessage = sendJobMessage) {}

  async send(jobId: string, taskIndex: number | undefined, message: string): Promise<void> {
    const result = await this.sendMessage({ jobId, taskIndex, message });
    if (!result.successBoolean) throw new Error(result.responseString || 'Slack job delivery failed');
  }
}

/** Creates stable conversation-history placeholders so retrying creation cannot duplicate Slack threads. */
export class ConversationHistorySlackThreadFactory implements PersistentThreadFactory {
  constructor(private readonly db = postgresClient) {}

  async create(title: string, metadata: { channel: 'slack'; workspaceId: string; conversationId: string; senderId?: string }): Promise<string> {
    const identity = metadata.senderId ? `dm:${metadata.senderId}` : 'inbox';
    const digest = createHash('sha256').update(`${metadata.channel}:${metadata.workspaceId}:${identity}`).digest('hex').slice(0, 32);
    const threadId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    await this.db.queryOne(
      `INSERT INTO conversation_history (id, thread_id, type, title, status, hidden, source, message_count, created_at, last_active_at)
       VALUES ($1,$1,'chat',$2,'active',FALSE,'slack',0,now(),now())
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, hidden=FALSE, source='slack'`,
      [threadId, title],
    );
    return threadId;
  }
}
