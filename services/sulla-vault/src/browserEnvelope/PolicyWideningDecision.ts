// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentPolicyWideningCheck } from '@sulla/domain';
import { DEFAULT_AGENT_POLICY, type AgentPolicy } from '@sulla/vault-crypto';

/**
 * Decides whether a pulled policy grants agents more than the local one does.
 * The comparison is the domain's (mode, level, agents allow-list, sites,
 * server agents, expiry, ask-first); this class only fills in fields an older
 * stored policy may lack, so a missing field can't read as "widened" or "same".
 */
export class PolicyWideningDecision {
  constructor(private readonly check: AgentPolicyWideningCheck = new AgentPolicyWideningCheck()) {}

  widens(current: Partial<AgentPolicy> | null | undefined, remote: Partial<AgentPolicy> | null | undefined): boolean {
    return this.check.widens(this.complete(current), this.complete(remote));
  }

  private complete(policy: Partial<AgentPolicy> | null | undefined): AgentPolicy {
    return {
      ...DEFAULT_AGENT_POLICY, ...policy,
      agents:    policy?.agents ?? [],
      sites:     policy?.sites ?? [],
      expiresAt: policy?.expiresAt ?? null,
    };
  }
}
