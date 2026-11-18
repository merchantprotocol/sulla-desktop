// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  agentCaTrust, ensureAgentNetworkCommand, THREAT_PROXY_PUBLIC_DIR, type EgressPolicyState,
} from '@pkg/backend/threatProxyEgress';

/** Proxy startup is optional; agent creation must remain available during outages. */
export const THREAT_PROXY_START_BUDGET_MS = 5_000;

/** Container label the threat-proxy watcher reads to spot agents that do not trust the proxy CA. */
export const THREAT_PROXY_CA_LABEL = 'sulla.threat-proxy.ca';

export interface AgentEgress { binds: string[]; env: Record<string, string>; caPresent: boolean }

/** Everything prepareAgentEgress touches outside itself, injected so the launch policy is testable. */
export interface AgentEgressDeps {
  guestExec(args: string[]): Promise<unknown>;
  egressEnforced(): Promise<boolean>;
  /** True when the threat proxy currently reports `running` (egress enforced and healthy). */
  proxyRunning(): Promise<boolean>;
  applyCurrentEgressPolicy(state: EgressPolicyState): Promise<void>;
  startProxy(): Promise<unknown>;
  warn(message: string, error: unknown): void;
}

/**
 * Re-apply the agent egress policy before every launch (a Docker or guest
 * restart drops nothing permanent, but this keeps the guarantee local to the
 * launch) and return CA trust only when the bundle exists. CA-less agents are
 * labeled so the watcher holds the policy in direct mode until they exit.
 */
export async function prepareAgentEgress(deps: AgentEgressDeps): Promise<AgentEgress> {
  await deps.guestExec(ensureAgentNetworkCommand());
  const enabled = await deps.egressEnforced();
  if (!enabled) { await deps.applyCurrentEgressPolicy('off'); return { binds: [], env: {}, caPresent: false }; }
  // Preserve already enforced traffic; direct is only a recovery/startup fallback.
  const alreadyEnforced = await deps.proxyRunning();
  if (!alreadyEnforced) {
    await deps.applyCurrentEgressPolicy('direct');
    void Promise.race([
      deps.startProxy(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('proxy startup budget exceeded')), THREAT_PROXY_START_BUDGET_MS)),
    ]).catch(error => deps.warn('[AgentContainer] threat proxy is unavailable; continuing direct', error));
  }
  const caPresent = () => deps.guestExec(['test', '-s', `${ THREAT_PROXY_PUBLIC_DIR }/ca-bundle.pem`]).then(() => true, () => false);
  const deadline = Date.now() + THREAT_PROXY_START_BUDGET_MS;
  while (!alreadyEnforced && Date.now() < deadline && !await caPresent()) await new Promise(resolve => setTimeout(resolve, 250));
  if (!await caPresent()) { await deps.applyCurrentEgressPolicy('direct'); return { binds: [], env: {}, caPresent: false }; }
  const trust = agentCaTrust();
  return { binds: trust.bind ? [trust.bind] : [], env: trust.env, caPresent: true };
}

/** Labels every agent container carries so the watcher can see CA-less agents. */
export function agentEgressLabels(egress: Pick<AgentEgress, 'caPresent'>): Record<string, string> {
  return { [THREAT_PROXY_CA_LABEL]: egress.caPresent ? 'present' : 'absent' };
}
