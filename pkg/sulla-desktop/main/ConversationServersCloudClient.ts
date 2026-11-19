// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { cloudRequest } from './cloud/cloudFetch';

export type ConversationServerNotificationLevel = 'all' | 'mentions' | 'nothing';
type CloudRequester = typeof cloudRequest;
type ConversationServerDto = { id: string; name: string; visibility: 'public' | 'organization'; orgId?: string; ownerUserId: string; notificationDefault: ConversationServerNotificationLevel };
type ConversationChannelDto = { id: string; serverId: string; name: string; kind: 'text' | 'a2a' | 'announcement'; private: boolean; memberUserIds?: string[] };
export type ConversationChannelMessage = { id: string; seq: number; authorUserId: string; authorAgentId?: string | null; kind: string; body: string; createdAt: string };
type ConversationServerMemberDto = { userId: string; role: string };

/** Reads server/channel contracts over the same brokered Cloud request path as the other Desktop clients. */
export class ConversationServersCloudClient {
  constructor(private readonly cloud: CloudRequester = (...args) => new LazyCloudRequester().request(...args)) {}

  async list(orgId?: string): Promise<ConversationServerDto[]> {
    const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
    const body = await this.request('GET', `/conversation-servers${query}`);
    return Array.isArray(body.servers) ? body.servers as ConversationServerDto[] : [];
  }

  async channels(serverId: string): Promise<ConversationChannelDto[]> {
    const body = await this.request('GET', `/conversation-servers/${encodeURIComponent(serverId)}/channels`);
    return Array.isArray(body.channels) ? body.channels as ConversationChannelDto[] : [];
  }

  async members(serverId: string): Promise<ConversationServerMemberDto[]> {
    const body = await this.request('GET', `/conversation-servers/${encodeURIComponent(serverId)}/members`);
    return Array.isArray(body.members) ? body.members as ConversationServerMemberDto[] : [];
  }

  async channelPreference(serverId: string, channelId: string): Promise<{ level: ConversationServerNotificationLevel; preference: ConversationServerNotificationLevel | null; channelOverride: ConversationServerNotificationLevel | null; serverDefault: ConversationServerNotificationLevel }> {
    const result = await this.request('GET', `/conversation-servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/notification-preference`);
    return result as unknown as { level: ConversationServerNotificationLevel; preference: ConversationServerNotificationLevel | null; channelOverride: ConversationServerNotificationLevel | null; serverDefault: ConversationServerNotificationLevel };
  }

  setServerDefault(serverId: string, level: ConversationServerNotificationLevel): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/conversation-servers/${encodeURIComponent(serverId)}/notification-default`, { level });
  }

  setChannelPreference(serverId: string, channelId: string, level: ConversationServerNotificationLevel | null): Promise<Record<string, unknown>> {
    return this.request('PUT', `/conversation-servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/notification-preference`, { level });
  }

  async messages(serverId: string, channelId: string, before?: number, after?: number): Promise<{ messages: ConversationChannelMessage[]; nextBefore?: number | null; latestSeq?: number }> {
    const query = new URLSearchParams({ limit: '50' });
    if (before !== undefined) query.set('before', String(before));
    if (after !== undefined) query.set('after', String(after));
    const result = await this.request('GET', `/conversation-servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages?${query}`);
    return { ...result, messages: Array.isArray(result.messages) ? result.messages as ConversationChannelMessage[] : [] };
  }

  sendMessage(serverId: string, channelId: string, body: string): Promise<Record<string, unknown>> {
    const text = body.trim();
    if (!text || text.length > 4000) throw new Error('Message must be between 1 and 4000 characters');
    return this.request('POST', `/conversation-servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages`, { body: text, kind: 'text' });
  }

  markRead(serverId: string, channelId: string, seq: number): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid read cursor');
    return this.request('POST', `/conversation-servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/read`, { seq });
  }

  unread(serverId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/conversation-servers/${encodeURIComponent(serverId)}/unread`);
  }

  private async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.cloud(method, path, { headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`Conversation servers unavailable (${response.status})`);
    return response.json() as Promise<Record<string, unknown>>;
  }
}

/** Loads cloudFetch on demand to keep controller imports from eagerly loading the Cloud transport. */
class LazyCloudRequester {
  async request(...args: Parameters<typeof cloudRequest>): Promise<Response> {
    return (await import('./cloud/cloudFetch')).cloudRequest(...args);
  }
}
