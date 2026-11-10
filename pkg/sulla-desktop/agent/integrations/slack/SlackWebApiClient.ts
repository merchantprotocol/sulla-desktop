// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { SlackApiError } from './SlackApiError';
import type { SlackAccountResolver } from './SlackAccountResolver';
import type { SlackApiTransport } from './SlackApiTransport';
import type { ToolExecutionContext } from '../../tools/executionContext';
export class SlackWebApiClient {
  private readonly teams = new Map<string, string>();
  constructor(private readonly transport: SlackApiTransport, private readonly accounts: SlackAccountResolver) {}
  async call(method: string, body: Record<string, unknown> = {}, executionContext?: ToolExecutionContext, account?: string): Promise<any> {
    const accountId = await this.accounts.resolve(account);
    const result = await this.transport.call({ accountId, method, body, executionContext });
    if (result.status < 200 || result.status >= 300 || result.body?.ok === false) throw new SlackApiError(method, String(result.body?.error ?? result.status), result.status);
    if (method === 'auth.test' && result.body?.team_id) this.teams.set(accountId, result.body.team_id);
    return { ...result.body, account: accountId, teamId: this.teams.get(accountId) ?? result.body?.team_id };
  }
  async postMessage(channel: string, text: string, threadTs?: string, executionContext?: ToolExecutionContext, account?: string) {
    const accountId = await this.accounts.resolve(account);
    if (!this.teams.has(accountId)) await this.call('auth.test', {}, executionContext, accountId);
    const result = await this.call('chat.postMessage', { channel, text, thread_ts: threadTs, mrkdwn: true }, executionContext, accountId);
    return { ...result, account: accountId, teamId: this.teams.get(accountId), channel, threadTs: threadTs ?? result.thread_ts ?? null };
  }
  update(channel: string, ts: string, text: string, executionContext?: ToolExecutionContext, account?: string) { return this.call('chat.update', { channel, ts, text }, executionContext, account); }
  threadReplies(channel: string, ts: string, limit = 100, executionContext?: ToolExecutionContext, account?: string) { return this.call('conversations.replies', { channel, ts, limit }, executionContext, account); }
  userInfo(user: string, executionContext?: ToolExecutionContext, account?: string) { return this.call('users.info', { user }, executionContext, account); }
  usersList(limit = 200, executionContext?: ToolExecutionContext, account?: string) { return this.call('users.list', { limit }, executionContext, account); }
  lookupUserByEmail(email: string, executionContext?: ToolExecutionContext, account?: string) { return this.call('users.lookupByEmail', { email }, executionContext, account); }
  reactionsRemove(channel: string, timestamp: string, name: string, executionContext?: ToolExecutionContext, account?: string) { return this.call('reactions.remove', { channel, timestamp, name }, executionContext, account); }
  authTest(executionContext?: ToolExecutionContext, account?: string) { return this.call('auth.test', {}, executionContext, account); }
  botsInfo(bot: string, executionContext?: ToolExecutionContext, account?: string) { return this.call('bots.info', { bot }, executionContext, account); }
}
