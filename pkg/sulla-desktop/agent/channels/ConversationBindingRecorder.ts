// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { BindingTarget, ChannelName, ConversationBindingRepository } from './types';
export class ConversationBindingRecorder {
  constructor(private readonly repository: ConversationBindingRepository) {}
  async recordOutbound(input: { channel: ChannelName; workspaceId: string; conversationId: string; threadKey: string; target: BindingTarget; agentId?: string }) {
    return this.repository.save({kind:'thread_reply',channel:input.channel,workspaceId:input.workspaceId,conversationId:input.conversationId,threadKey:input.threadKey,target:input.target,...(input.agentId?{agentId:input.agentId}:{})});
  }
}
