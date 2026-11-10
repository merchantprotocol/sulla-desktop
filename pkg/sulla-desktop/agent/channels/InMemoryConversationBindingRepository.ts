// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { BindingKind, ChannelName, ConversationBinding, ConversationBindingRepository } from './types';
export class InMemoryConversationBindingRepository implements ConversationBindingRepository {
  private readonly bindings: ConversationBinding[] = [];
  private readonly receipts = new Set<string>();
  async findThread(channel: ChannelName, workspaceId: string, conversationId: string, threadKey: string): Promise<ConversationBinding | null> {
    return this.bindings.find(b => b.kind === 'thread_reply' && b.channel === channel && b.workspaceId === workspaceId && b.conversationId === conversationId && b.threadKey === threadKey) ?? null;
  }
  async findFallback(kind: 'dm_person' | 'inbox', channel: ChannelName, workspaceId: string, senderId?: string): Promise<ConversationBinding | null> {
    return this.bindings.find(b => b.kind === kind && b.channel === channel && b.workspaceId === workspaceId && (kind === 'inbox' || b.senderId === senderId)) ?? null;
  }
  async save(binding: ConversationBinding): Promise<ConversationBinding> {
    const existing = binding.kind === 'thread_reply' && binding.threadKey
      ? await this.findThread(binding.channel, binding.workspaceId, binding.conversationId, binding.threadKey)
      : await this.findFallback(binding.kind as Exclude<BindingKind, 'thread_reply'>, binding.channel, binding.workspaceId, binding.senderId);
    if (existing) return existing;
    this.bindings.push(binding); return binding;
  }
  async claimReceipt(channel: ChannelName, eventId: string): Promise<boolean> {
    const key = `${channel}:${eventId}`; if (this.receipts.has(key)) return false; this.receipts.add(key); return true;
  }
}
