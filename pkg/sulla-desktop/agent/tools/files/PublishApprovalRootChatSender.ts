// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatMessageBus } from '../ToolSessionChatTransport';

export interface PublishApprovalChatTarget { channel: string; threadId: string }

export interface PublishApprovalCardSender {
  send(target: PublishApprovalChatTarget, toolApproval: Record<string, unknown>): Promise<boolean>;
}

/**
 * Delivers a Files publish approval card to the visible chat at the top of a
 * delegated caller's ancestry. The target comes from persisted job ancestry,
 * never from tool input, and the card only carries the decision id: the chat
 * renders its text from the decision record.
 */
export class PublishApprovalRootChatSender implements PublishApprovalCardSender {
  constructor(private readonly bus: () => Promise<ChatMessageBus> = PublishApprovalRootChatSender.defaultBus) {}

  async send(target: PublishApprovalChatTarget, toolApproval: Record<string, unknown>): Promise<boolean> {
    if (!target.channel || !target.threadId) return false;
    const bus = await this.bus();
    return bus.send(target.channel, {
      type: 'assistant_message',
      data: { content: '', role: 'assistant', kind: 'tool_approval', thread_id: target.threadId, timestamp: Date.now(), toolApproval },
    });
  }

  private static async defaultBus(): Promise<ChatMessageBus> {
    const { getWebSocketClientService } = await import('../../services/WebSocketClientService');
    return getWebSocketClientService();
  }
}
