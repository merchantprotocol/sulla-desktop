// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { ConversationBinding, InboundMessage, InboundMessageDelivery } from './types';
export interface ChatChannelSender { send(threadId: string, content: string, metadata: Record<string, string>): Promise<void> }
export interface JobChannelSender { send(jobId: string, taskIndex: number | undefined, message: string): Promise<void> }
export class ChannelInboundDelivery implements InboundMessageDelivery {
  constructor(private readonly chat: ChatChannelSender, private readonly jobs: JobChannelSender) {}
  async deliver(binding: ConversationBinding, message: InboundMessage, content: string, trustLevel: 'directive'|'information_only'): Promise<void> {
    const metadata={source:'slack',workspaceId:message.workspaceId,channelId:message.conversationId,threadTs:message.threadKey,senderId:message.senderId,eventId:message.eventId,trustLevel};
    if(binding.target.kind==='chat') return this.chat.send(binding.target.threadId,content,metadata);
    return this.jobs.send(binding.target.jobId,binding.target.taskIndex,content);
  }
}
