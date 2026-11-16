// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { ChannelAdapter, InboundMessage } from './types';

interface SlackEvent { type?: string; user?: string; text?: string; channel?: string; channel_type?: string; ts?: string; thread_ts?: string; bot_id?: string; subtype?: string }
export class SlackChannelAdapter implements ChannelAdapter<SlackEvent> {
  normalize(event: SlackEvent, frame: Record<string, unknown>): InboundMessage | null {
    if (!event || event.type !== 'message' || !event.user || !event.channel || !event.ts || typeof event.text !== 'string') return null;
    if (event.bot_id || event.subtype) return null;
    const workspaceId = typeof frame.teamId === 'string' ? frame.teamId : '';
    const eventId = typeof frame.eventId === 'string' ? frame.eventId : '';
    if (!workspaceId || !eventId) return null;
    return { channel: 'slack', workspaceId, conversationId: event.channel, threadKey: event.thread_ts || event.ts,
      messageTs: event.ts, senderId: event.user, text: event.text,
      isDirectMessage: event.channel_type === 'im' || event.channel.startsWith('D'), eventId };
  }
}
