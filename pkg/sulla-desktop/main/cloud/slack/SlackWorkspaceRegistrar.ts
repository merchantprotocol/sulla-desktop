// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { SlackAccountResolver } from '@pkg/agent/integrations/slack/SlackAccountResolver';
import { BrokerSlackApiTransport } from '@pkg/agent/integrations/slack/BrokerSlackApiTransport';
import { SlackSystemContextIssuer } from '@pkg/agent/integrations/slack/SlackSystemContextIssuer';
import { SlackWebApiClient } from '@pkg/agent/integrations/slack/SlackWebApiClient';
import type { SlackWorkspaceAccountRegistry } from '@pkg/agent/channels/SlackWorkspaceAccountRegistry';
import type { SlackCloudClient } from './SlackCloudClient';

/** Registers each connected Slack workspace with Cloud and records its local account mapping. */
export class SlackWorkspaceRegistrar {
  private readonly api: SlackWebApiClient;
  private readonly registeredOrClaimedAccounts = new Set<string>();
  private readonly registeringAccounts = new Set<string>();
  constructor(private readonly cloud: SlackCloudClient, private readonly accountsByTeam: SlackWorkspaceAccountRegistry,
    private readonly integrations = getIntegrationService(), private readonly issuer = new SlackSystemContextIssuer(),
    api?: SlackWebApiClient) {
    this.api = api ?? new SlackWebApiClient(new BrokerSlackApiTransport(), new SlackAccountResolver(integrations));
  }
  async registerConnectedWorkspaces(): Promise<void> {
    const accounts = await this.integrations.getAccounts('slack');
    for (const account of accounts.filter(candidate => candidate.connected && candidate.credentialRequired !== false)) {
      if (this.registeredOrClaimedAccounts.has(account.account_id) || this.registeringAccounts.has(account.account_id)) continue;
      this.registeringAccounts.add(account.account_id);
      try {
        const context = await this.issuer.issue(account.account_id);
        const auth = await this.api.authTest(context, account.account_id);
        const teamId = typeof auth.team_id === 'string' ? auth.team_id : '';
        const botId = typeof auth.bot_id === 'string' ? auth.bot_id : '';
        if (teamId) this.accountsByTeam.register(teamId, account.account_id);
        if (!teamId || !botId) continue;
        const bot = await this.api.botsInfo(botId, context, account.account_id);
        const apiAppId = bot.bot?.app_id;
        if (typeof apiAppId !== 'string' || !apiAppId) continue;
        await this.cloud.registerWorkspace(apiAppId, teamId);
        this.registeredOrClaimedAccounts.add(account.account_id);
        console.info('[SlackWorkspaceRegistrar] Registered workspace', { teamId, accountId: account.account_id });
      } catch (error) {
        if (error instanceof Error && error.message === 'workspace_claimed') {
          this.registeredOrClaimedAccounts.add(account.account_id);
          console.warn('[SlackWorkspaceRegistrar] Workspace is already claimed by another Desktop', { accountId: account.account_id });
          continue;
        }
        console.warn('[SlackWorkspaceRegistrar] Workspace registration failed', { accountId: account.account_id });
      } finally {
        this.registeringAccounts.delete(account.account_id);
      }
    }
  }
}
