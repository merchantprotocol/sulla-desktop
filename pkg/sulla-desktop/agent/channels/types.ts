// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type ChannelName = 'slack';
export interface InboundMessage {
  channel: ChannelName; workspaceId: string; conversationId: string; threadKey: string;
  messageTs: string; senderId: string; text: string; displayName?: string;
  isDirectMessage: boolean; eventId: string; context?: string[];
}
export interface ChannelAdapter<TEvent = unknown> { normalize(event: TEvent, frame: Record<string, unknown>): InboundMessage | null }
export type BindingKind = 'thread_reply' | 'dm_person' | 'inbox';
export type BindingTarget = { kind: 'chat'; threadId: string } | { kind: 'job'; jobId: string; taskIndex?: number };
export interface ConversationBinding {
  kind: BindingKind; channel: ChannelName; workspaceId: string; conversationId: string;
  threadKey?: string; senderId?: string; target: BindingTarget; agentId?: string;
}
export interface ConversationBindingRepository {
  findThread(channel: ChannelName, workspaceId: string, conversationId: string, threadKey: string): Promise<ConversationBinding | null>;
  findFallback(kind: 'dm_person' | 'inbox', channel: ChannelName, workspaceId: string, senderId?: string): Promise<ConversationBinding | null>;
  save(binding: ConversationBinding): Promise<ConversationBinding>;
  claimReceipt(channel: ChannelName, eventId: string): Promise<boolean>;
}
export interface InboundRouter { route(message: InboundMessage): Promise<{ binding: ConversationBinding; trustLevel: 'directive' | 'information_only'; content: string } | null> }
export interface InboundMessageDelivery { deliver(binding: ConversationBinding, message: InboundMessage, content: string, trustLevel: 'directive' | 'information_only'): Promise<void> }
export interface SenderAllowlist { allows(channel: ChannelName, senderId: string): Promise<boolean> }
export interface ThreadContextSource { fetchRecent(workspaceId: string, conversationId: string, threadKey: string, limit: number): Promise<string[]> }
export interface PersistentThreadFactory { create(title: string, metadata: { channel: ChannelName; workspaceId: string; conversationId: string }): Promise<string> }
export interface ChannelEventHandler { handle(frame: Record<string, unknown>): Promise<void> }
