// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { SlackWebApiClient } from '../integrations/slack/SlackWebApiClient';
import type { SlackWorkspaceAccountRegistry } from './SlackWorkspaceAccountRegistry';
import type { ThreadContextSource } from './types';
import type { SlackSystemContextIssuer } from '../integrations/slack/SlackSystemContextIssuer';

/** Fetches bounded thread history with locally issued Slack authority; failures are non-fatal. */
export class SlackThreadContextSource implements ThreadContextSource {
  constructor(private readonly api: SlackWebApiClient, private readonly accounts: SlackWorkspaceAccountRegistry,
    private readonly issuer: SlackSystemContextIssuer) {}
  async fetchRecent(workspaceId: string, conversationId: string, threadKey: string, limit: number): Promise<string[]> {
    const accountId = this.accounts.resolve(workspaceId);
    if (!accountId) return [];
    try {
      const context = await this.issuer.issue(accountId);
      const result = await this.api.threadReplies(conversationId, threadKey, Math.min(10, Math.max(1, limit)), context, accountId);
      return (result.messages ?? []).map((message: any) => `${message.user ?? message.bot_id ?? 'unknown'}: ${message.text ?? ''} (${message.ts ?? ''})`);
    } catch { return []; }
  }
}
