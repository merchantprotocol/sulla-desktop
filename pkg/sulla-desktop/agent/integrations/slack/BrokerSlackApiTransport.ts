// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { configuredVaultBrokerProvider, type VaultBrokerServiceProvider } from '../../../vault-broker';
import { getIntegrationService } from '../../services/IntegrationService';
import type { SlackApiTransport, SlackApiTransportRequest, SlackApiTransportResponse } from './SlackApiTransport';

type SlackAccountSource = Pick<ReturnType<typeof getIntegrationService>, 'getAccounts'>;
type CredentialBrokerSource = Pick<VaultBrokerServiceProvider, 'requireConfiguredCredentialBroker'>;

/** Sends Slack Web API calls through the vault broker; the bot token never leaves the vault. */
export class BrokerSlackApiTransport implements SlackApiTransport {
  constructor(
    private readonly brokers: CredentialBrokerSource = configuredVaultBrokerProvider,
    private readonly accounts: () => SlackAccountSource = getIntegrationService,
  ) {}

  async call(input: SlackApiTransportRequest): Promise<SlackApiTransportResponse> {
    const accounts = await this.accounts().getAccounts('slack');
    if (!accounts.some(candidate => candidate.account_id === input.accountId)) throw new Error(`Unknown Slack account: ${ input.accountId }`);
    if (!input.executionContext || input.executionContext.credential_scope?.integration_id !== 'slack' || input.executionContext.credential_scope.account_id !== input.accountId) {
      throw new Error('slack.web-api requires a signed credential scope for the requested Slack account');
    }
    const broker = this.brokers.requireConfiguredCredentialBroker();
    const result = await broker.execute(broker.requestFor(input.executionContext, {
      operation: 'slack.web-api', ref: { integrationId: 'slack', accountId: input.accountId },
      url: `https://slack.com/api/${ input.method }`, method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: input.body, injections: [{ field: 'bot_token', target: 'header', name: 'authorization', scheme: 'Bearer' }], responseType: 'json',
    }));
    return { status: result.status, body: (result.body ?? {}) as Record<string, any> };
  }
}
