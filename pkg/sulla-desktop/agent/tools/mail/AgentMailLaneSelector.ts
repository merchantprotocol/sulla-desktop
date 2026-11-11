// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailAddress } from './AgentMailAddress';
import { AGENT_MAIL_INTEGRATION_ID, AGENT_MAIL_TOKEN_FIELD, SULLA_CLOUD_INTEGRATION_ID } from './AgentMailTransport';

export type AgentMailLane = typeof AGENT_MAIL_INTEGRATION_ID | typeof SULLA_CLOUD_INTEGRATION_ID;

/**
 * Picks the credential lane for one mail tool call. User mailboxes always
 * use the signed-in user's Cloud session. Only the internal service
 * mailboxes (sulla@, qa@, e2e@) use the global AGENT_MAIL_TOKEN, and only
 * when that vault account exists.
 */
export class AgentMailLaneSelector {
  static readonly SERVICE_LOCAL_PARTS: readonly string[] = ['sulla', 'qa', 'e2e'];

  constructor(
    private readonly serviceAccountExists: () => Promise<boolean> = AgentMailLaneSelector.vaultHasServiceAccount,
    private readonly domain = AgentMailAddress.DOMAIN,
  ) {}

  /** The mailbox an endpoint's params name; legacy `to`/`from_local` still work. */
  static mailboxArg(endpoint: string, params: Record<string, unknown> | undefined): unknown {
    const values = params ?? {};
    if (values.mailbox !== undefined && values.mailbox !== null && values.mailbox !== '') return values.mailbox;
    const tool = endpoint.replace(/^mail_/, '');
    if (tool === 'send') return values.from_local;
    if (tool === 'list' || tool === 'wait_for_code') return values.to;
    return undefined;
  }

  isServiceMailbox(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return false;
    const at = normalized.lastIndexOf('@');
    if (at !== -1 && normalized.slice(at + 1) !== this.domain) return false;
    return AgentMailLaneSelector.SERVICE_LOCAL_PARTS.includes(at === -1 ? normalized : normalized.slice(0, at));
  }

  async lane(endpoint: string, params: Record<string, unknown> | undefined): Promise<AgentMailLane> {
    if (!this.isServiceMailbox(AgentMailLaneSelector.mailboxArg(endpoint, params))) return SULLA_CLOUD_INTEGRATION_ID;
    return await this.serviceAccountExists().catch(() => false) ? AGENT_MAIL_INTEGRATION_ID : SULLA_CLOUD_INTEGRATION_ID;
  }

  /** True when the sulla_agent_mail account (the service AGENT_MAIL_TOKEN) is configured. */
  static async vaultHasServiceAccount(): Promise<boolean> {
    const vault = await import('../../../vault-broker');
    const { getIntegrationService } = await import('../../services/IntegrationService');
    try {
      if (vault.usesContainerVaultAuthority()) return Boolean(await getIntegrationService().getActiveAccountId(AGENT_MAIL_INTEGRATION_ID));
      return Boolean((await getIntegrationService().getIntegrationValue(AGENT_MAIL_INTEGRATION_ID, AGENT_MAIL_TOKEN_FIELD))?.value);
    } catch {
      return false;
    }
  }
}
