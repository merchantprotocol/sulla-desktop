// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getIntegrationService } from '../../services/IntegrationService';
import { BrokerSlackApiTransport } from './BrokerSlackApiTransport';
import { SlackAccountResolver } from './SlackAccountResolver';
import { SlackWebApiClient } from './SlackWebApiClient';
import type { ToolExecutionContext } from '../../tools/executionContext';

export class SlackClient {
  private static instance: SlackClient | null = null;
  private readonly api: SlackWebApiClient;
  private constructor(api = new SlackWebApiClient(new BrokerSlackApiTransport(), new SlackAccountResolver(getIntegrationService()))) { this.api = api; }
  static getInstance(): SlackClient { return this.instance ??= new SlackClient(); }
  async initialize(): Promise<boolean> { return true; }
  isConnected(): boolean { return true; }
  getLastInitializeError(): string | null { return null; }
  async close(): Promise<void> {}
  async sendMessage(channel: string, text: string, threadTs?: string, _blocks?: any[], context?: ToolExecutionContext, account?: string): Promise<any> { return this.api.postMessage(channel, text, threadTs, context, account); }
  async replyInThread(channel: string, threadTs: string, text: string, _blocks?: any[], context?: ToolExecutionContext, account?: string): Promise<any> { return this.sendMessage(channel, text, threadTs, undefined, context, account); }
  async updateMessage(channel: string, ts: string, text: string, _blocks?: any[], context?: ToolExecutionContext, account?: string): Promise<any> { return this.api.update(channel, ts, text, context, account); }
  async addReaction(channel: string, ts: string, reaction: string, context?: ToolExecutionContext, account?: string): Promise<any> { return this.api.call('reactions.add', { channel, timestamp: ts, name: reaction }, context, account); }
  async removeReaction(channel: string, ts: string, reaction: string, context?: ToolExecutionContext, account?: string): Promise<any> { return this.api.reactionsRemove(channel, ts, reaction, context, account); }
  async joinChannel(channel: string, context?: ToolExecutionContext, account?: string): Promise<any> { return this.api.call('conversations.join', { channel }, context, account); }
  async listChannels(types: string[] = ['public_channel'], context?: ToolExecutionContext, account?: string): Promise<any[]> { return (await this.api.call('conversations.list', { types: types.join(','), limit: 1000 }, context, account)).channels ?? []; }
  async getUserInfo(user: string, context?: ToolExecutionContext, account?: string): Promise<any> { return (await this.api.userInfo(user, context, account)).user; }
  async apiCall(method: string, params: Record<string, any> = {}, context?: ToolExecutionContext, account?: string): Promise<any> { return this.api.call(method, params, context, account); }
  async searchUsers(query: string, limit = 10, context?: ToolExecutionContext, account?: string): Promise<any[]> {
    const q = String(query || '').trim().toLowerCase(); if (!q) return [];
    const response = await this.api.usersList(200, context, account);
    return (response.members ?? []).filter((user: any) => !user?.deleted && !user?.is_bot).filter((user: any) => [user?.name, user?.real_name, user?.profile?.real_name, user?.profile?.display_name, user?.profile?.email].some(value => String(value || '').toLowerCase().includes(q))).slice(0, Math.max(1, limit));
  }
  async getChannelHistory(channel: string, limit = 50, oldest?: string, latest?: string, context?: ToolExecutionContext, account?: string): Promise<any[]> { return (await this.api.call('conversations.history', { channel, limit, oldest, latest, inclusive: true }, context, account)).messages ?? []; }
  async getThreadReplies(channel: string, ts: string, context?: ToolExecutionContext, account?: string): Promise<any[]> { return (await this.api.threadReplies(channel, ts, 100, context, account)).messages ?? []; }
}
export const slackClient = SlackClient.getInstance();
