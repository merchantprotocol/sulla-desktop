import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';

import {
  createProviderCliBridge,
  issueLocalBrokerContext,
  usesContainerVaultAuthority,
  type ProviderCliAuthMode,
  type ProviderCliBridgeLease,
} from '../../vault-broker';
import { getIntegrationService } from '../services/IntegrationService';

import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';

import type { BaseThreadState } from '../nodes/Graph';

/** How often a bridge checks whether the `claude` process it serves is still alive. */
const PROCESS_WATCH_MS = 5_000;
/** Short-lived caller claims; renewed on every bridge request while the process lives. */
const CONTEXT_TTL_S = 300;

export interface LimaClaudeAuth {
  /** `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` — an opaque bridge capability, never the real credential. */
  oauthToken: string;
  apiKey:     string;
  /** `ANTHROPIC_BASE_URL` pointing at the host-side broker bridge. */
  baseUrl:    string;
  lease:      ProviderCliBridgeLease;
}

const MISSING_ACCOUNT = 'No local vault account is configured for claude-code';

async function resolveAccount(): Promise<{
  integrationId: 'anthropic' | 'claude-code';
  accountId:     string;
  authMode:      ProviderCliAuthMode;
}> {
  const integrations = getIntegrationService();
  try {
    const accountId = await integrations.getActiveAccountId('claude-code');
    return { integrationId: 'claude-code', accountId, authMode: accountId === 'oauth' ? 'oauth' : 'api-key' };
  } catch (error) {
    if ((error as Error).message !== MISSING_ACCOUNT) throw error;
  }
  try {
    return {
      integrationId: 'anthropic',
      accountId:     await integrations.getActiveAccountId('anthropic'),
      authMode:      'api-key',
    };
  } catch {
    throw new Error('No Claude credentials configured. Sign in via Integrations → Claude Code.');
  }
}

/**
 * With the container-owned Vault, secrets never leave the vault, so a `claude`
 * process in the Lima VM cannot be handed a token. Instead it gets a
 * process-scoped bridge on the host that the broker injects the real
 * credential through. Returns null when the legacy in-process vault is in use
 * (callers then fall back to reading the credential directly).
 */
export async function createLimaClaudeAuth(input: {
  conversationId: string;
  state?:         BaseThreadState;
}): Promise<LimaClaudeAuth | null> {
  if (!usesContainerVaultAuthority()) return null;

  const { integrationId, accountId, authMode } = await resolveAccount();
  const metadata = (input.state?.metadata ?? {}) as { agentId?: string; wsChannel?: string; orgId?: string };
  const base = await issueLocalBrokerContext({
    agentId:         metadata.agentId ?? metadata.wsChannel ?? 'sulla',
    podId:           `sulla-lima-claude-${ crypto.randomUUID() }`,
    credentialScope: { integration_id: integrationId, account_id: accountId },
    threadId:        input.conversationId,
    jobId:           `lima-${ crypto.randomUUID() }`,
    orgId:           metadata.orgId,
  });
  const context = { ...base, device_id: await getDesktopDeviceId() };
  const renewed = () => {
    const now = Math.floor(Date.now() / 1000);
    return { ...context, iat: now, exp: now + CONTEXT_TTL_S };
  };

  const lease = await createProviderCliBridge({
    context:        renewed(),
    provider:       'claude-code',
    accountId,
    authMode,
    advertisedHost: new URL(getMCPServerHost().getVmReachableUrl()).hostname,
    // Lifecycle is owned by the claude process (see bindLeaseToProcess); the
    // lease is revoked when it exits, so each request just renews its claims.
    authorize:      renewed,
  });
  const env = lease.config.environment;
  return {
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    apiKey:     env.ANTHROPIC_API_KEY ?? '',
    baseUrl:    lease.config.baseUrl,
    lease,
  };
}

export function releaseLease(lease: ProviderCliBridgeLease | null | undefined): void {
  if (!lease) return;
  lease.revoke();
  lease.close().catch(() => {});
}

/**
 * Revoke the bridge once the process it serves is gone. Polled rather than
 * event-driven: the service strips exit/close listeners when it adopts a
 * pooled process, which would silently drop a listener-based cleanup.
 */
export function bindLeaseToProcess(proc: childProcess.ChildProcess, lease: ProviderCliBridgeLease | null | undefined): void {
  if (!lease) return;
  const timer = setInterval(() => {
    if (proc.exitCode === null && proc.signalCode === null && !lease.signal.aborted) return;
    clearInterval(timer);
    releaseLease(lease);
  }, PROCESS_WATCH_MS);
  timer.unref();
}
