// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';

import { AgentMailboxClient } from './AgentMailboxClient';
import { AgentMailClient } from './AgentMailClient';
import { AgentMailError } from './AgentMailError';
import { AgentMailLaneSelector } from './AgentMailLaneSelector';
import { AgentMailRouter } from './AgentMailRouter';
import {
  AGENT_MAIL_INTEGRATION_ID,
  AGENT_MAIL_TOKEN_FIELD,
  BrokerAgentMailTransport,
  CloudSessionAgentMailTransport,
  DirectAgentMailTransport,
  SULLA_CLOUD_INTEGRATION_ID,
  type AgentMailTransport,
} from './AgentMailTransport';

/**
 * Builds the mail service on the same Sulla Cloud origin every other Cloud
 * call uses: user mailboxes on the user's Cloud session, plus the service
 * mailbox lane when the sulla_agent_mail account exists.
 */
export class AgentMailClientFactory {
  constructor(
    private readonly baseUrl = CLOUD_API_BASE,
    private readonly serviceAccountExists: () => Promise<boolean> = AgentMailLaneSelector.vaultHasServiceAccount,
  ) {}

  async create(): Promise<AgentMailRouter> {
    const service = await this.serviceAccountExists() ? new AgentMailClient(await this.serviceTransport()) : null;
    return new AgentMailRouter(new AgentMailboxClient(await this.userTransport()), service);
  }

  private async userTransport(): Promise<AgentMailTransport> {
    const vault = await import('../../../vault-broker');
    if (vault.usesContainerVaultAuthority()) {
      const { getIntegrationService } = await import('../../services/IntegrationService');
      return new CloudSessionAgentMailTransport(
        this.baseUrl,
        async() => vault.requireConfiguredCredentialBroker(),
        () => getIntegrationService().getActiveAccountId(SULLA_CLOUD_INTEGRATION_ID),
      );
    }
    // Legacy in-process session (no vault authority): same token source as main/cloud/cloudFetch.ts.
    const { getCurrentAccessToken } = await import('@pkg/main/sullaCloudAuth');
    return new DirectAgentMailTransport(this.baseUrl, getCurrentAccessToken, undefined, () => AgentMailError.notSignedIn());
  }

  private async serviceTransport(): Promise<AgentMailTransport> {
    const vault = await import('../../../vault-broker');
    const { getIntegrationService } = await import('../../services/IntegrationService');
    if (vault.usesContainerVaultAuthority()) {
      return new BrokerAgentMailTransport(
        this.baseUrl,
        async() => vault.requireConfiguredCredentialBroker(),
        () => getIntegrationService().getActiveAccountId(AGENT_MAIL_INTEGRATION_ID),
      );
    }
    return new DirectAgentMailTransport(
      this.baseUrl,
      async() => (await getIntegrationService().getIntegrationValue(AGENT_MAIL_INTEGRATION_ID, AGENT_MAIL_TOKEN_FIELD))?.value ?? null,
    );
  }
}
