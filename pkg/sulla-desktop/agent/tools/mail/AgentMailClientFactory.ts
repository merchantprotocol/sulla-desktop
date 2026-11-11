// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';

import { AgentMailClient } from './AgentMailClient';
import {
  AGENT_MAIL_INTEGRATION_ID,
  AGENT_MAIL_TOKEN_FIELD,
  BrokerAgentMailTransport,
  DirectAgentMailTransport,
  type AgentMailTransport,
} from './AgentMailTransport';

/** Builds the mail client on the same Sulla Cloud origin every other Cloud call uses. */
export class AgentMailClientFactory {
  constructor(private readonly baseUrl = CLOUD_API_BASE) {}

  async create(): Promise<AgentMailClient> {
    return new AgentMailClient(await this.transport());
  }

  private async transport(): Promise<AgentMailTransport> {
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
