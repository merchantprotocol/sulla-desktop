// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { ChannelName, ConversationBinding, ConversationBindingRepository } from './types';
export class InMemoryConversationBindingRepository implements ConversationBindingRepository {
  private readonly bindings: ConversationBinding[] = [];
  private readonly receipts = new Map<string, 'processing' | 'complete'>();
  async findThread(channel: ChannelName, workspaceId: string, conversationId: string, threadKey: string): Promise<ConversationBinding | null> {
    return this.bindings.find(b => b.kind === 'thread_reply' && b.channel === channel && b.workspaceId === workspaceId && b.conversationId === conversationId && b.threadKey === threadKey) ?? null;
  }
  async findFallback(kind: 'dm_person' | 'inbox', channel: ChannelName, workspaceId: string, senderId?: string): Promise<ConversationBinding | null> {
    return this.bindings.find(b => b.kind === kind && b.channel === channel && b.workspaceId === workspaceId && (kind === 'inbox' || b.senderId === senderId)) ?? null;
  }
  /** Lookup and insert run synchronously, like the Postgres ON CONFLICT insert, so concurrent saves cannot both win. */
  async save(binding: ConversationBinding): Promise<ConversationBinding> {
    const existing = binding.kind === 'thread_reply' && binding.threadKey
      ? this.bindings.find(b => b.kind === 'thread_reply' && b.channel === binding.channel && b.workspaceId === binding.workspaceId && b.conversationId === binding.conversationId && b.threadKey === binding.threadKey)
      : this.bindings.find(b => b.kind === binding.kind && b.channel === binding.channel && b.workspaceId === binding.workspaceId && (binding.kind === 'inbox' || b.senderId === binding.senderId));
    if (existing) return existing;
    this.bindings.push(binding); return binding;
  }
  async claimReceipt(channel: ChannelName, eventId: string): Promise<boolean> {
    const key = `${channel}:${eventId}`; if (this.receipts.has(key)) return false; this.receipts.set(key, 'processing'); return true;
  }
  async completeReceipt(channel: ChannelName, eventId: string): Promise<void> { this.receipts.set(`${channel}:${eventId}`, 'complete'); }
  async isReceiptComplete(channel: ChannelName, eventId: string): Promise<boolean> { return this.receipts.get(`${channel}:${eventId}`) === 'complete'; }
  async releaseReceipt(channel: ChannelName, eventId: string): Promise<void> { if (this.receipts.get(`${channel}:${eventId}`) === 'processing') this.receipts.delete(`${channel}:${eventId}`); }
}
