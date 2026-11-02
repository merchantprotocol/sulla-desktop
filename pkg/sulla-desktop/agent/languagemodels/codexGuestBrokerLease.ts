// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import {
  createProviderCliBridge,
  issueLocalBrokerContext,
  type ProviderCliBridgeLease,
} from '../../vault-broker';
import { getIntegrationService } from '../services/IntegrationService';

import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';

import type { BaseThreadState } from '../nodes/Graph';

/** Short-lived caller claims; renewed on every bridge request while the process lives. */
const CONTEXT_TTL_S = 300;

/**
 * ContainerBrokerLease for a guest (non-container) spawn: the container-vault
 * authority owns the ChatGPT session, so a `codex exec` inside the Sulla VM
 * gets the same opaque-capability bridge a container run gets (see
 * guestClaudeBridge.ts for the Claude sibling) — never the raw token.
 * Without this, ensureCodexAuthFile() used to short-circuit "true" for this
 * exact case and let the guest spawn with no credentials at all (oauth-overhaul
 * audit finding #1).
 */
export async function createGuestCodexBrokerLease(input: {
  conversationId: string;
  state?:         BaseThreadState;
}): Promise<ProviderCliBridgeLease> {
  const integrations = getIntegrationService();
  const accountId = await integrations.getActiveAccountId('codex');

  // Codex routes ChatGPT plan usage through the chatgpt_account_id claim the
  // vault extracted at sign-in. A silently empty header here would route the
  // call to the wrong — or no — account deep inside the run; fail before spawn.
  const metadataValues = await integrations.getMetadataValues('codex', accountId);
  const hasAccountRoutingClaim = metadataValues.some(value => value.property === 'chatgpt_account_id' && value.value.trim());
  if (!hasAccountRoutingClaim) {
    throw new Error('Codex account is missing its ChatGPT account routing claim');
  }

  const metadata = (input.state?.metadata ?? {}) as { agentId?: string; wsChannel?: string; orgId?: string };
  const base = await issueLocalBrokerContext({
    agentId:         metadata.agentId ?? metadata.wsChannel ?? 'sulla',
    podId:           `sulla-guest-codex-${ crypto.randomUUID() }`,
    credentialScope: { integration_id: 'codex', account_id: accountId },
    threadId:        input.conversationId,
    jobId:           `guest-${ crypto.randomUUID() }`,
    orgId:           metadata.orgId,
  });
  const context = { ...base, device_id: await getDesktopDeviceId() };
  const renewed = () => {
    const now = Math.floor(Date.now() / 1_000);
    return { ...context, iat: now, exp: now + CONTEXT_TTL_S };
  };

  return createProviderCliBridge({
    context:        renewed(),
    provider:       'codex',
    accountId,
    advertisedHost: new URL(getMCPServerHost().getVmReachableUrl()).hostname,
    authorize:      renewed,
  });
}
