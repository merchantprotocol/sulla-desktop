// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentAccessPolicy, type AgentAccessDecision, type AgentAccessRequest, type AgentOperation } from '@sulla/domain';
import type { AgentAccessLevel, AgentPolicy } from '@sulla/vault-crypto';

/** What a Desktop caller asks: may this agent use the item at this level, on this host? */
export interface AgentPolicyGateRequest {
  agentId:   string;
  /** The level the use needs (metadata < autofill < full). */
  level:     AgentAccessLevel;
  /** Destination host; required when the item names sites. */
  host?:     string;
  /** The agent runs on the org server rather than this Desktop. */
  onServer?: boolean;
  /** Decision time; defaults to the gate's clock. */
  now?:      Date;
}

/** Same shape the legacy `agentPolicyAllows` returned, so callers swap without change. */
export interface AgentPolicyGateDecision {
  allowed: boolean;
  reason?: string;
}

/** Desktop's clock seam, so expiry decisions are testable. */
export interface AgentPolicyGateClock {
  now(): Date;
}

class SystemAgentPolicyGateClock implements AgentPolicyGateClock {
  now(): Date {
    return new Date();
  }
}

/**
 * Desktop's agent-use check for a vault item, decided by `@sulla/domain` AgentAccessPolicy (ledger D5/E2).
 *
 * Desktop keeps three guards the domain policy doesn't have, so the switch never widens access:
 *   1. Fail closed unless the item explicitly says `mode: 'agents'` (the domain allows a missing policy and
 *      only refuses `only_me`).
 *   2. Reject malformed policies (bad level, `sites` not an array, `agents` neither null nor an array).
 *   3. When the item names sites, the host must be a bare hostname: trimmed, lowercased, no port, no path
 *      (`new URL('https://' + host).hostname === host`).
 * `now` defaults to the injected clock; the domain refuses an expiring policy without one.
 *
 * Deliberate differences from the legacy copy, pinned in AgentPolicyGateParity.spec.ts:
 *   - When several rules fail at once, the reported reason follows the gate order
 *     (owner-only → malformed → host validity → expiry → agent list → server agents → sites → level) instead of
 *     Desktop's (owner-only → malformed → agent list → level → expiry → server agents → host → sites).
 *     Allow/deny never changes.
 *   - Sites are matched with the domain's normalization: a trailing dot and a stored `https://` prefix
 *     or path on the site are ignored ("example.com." and "https://example.com/x" both mean example.com).
 *   - An unknown requested level is refused (the legacy copy compared `undefined > n` and allowed it).
 */
export class AgentPolicyGate {
  private static sharedInstance: AgentPolicyGate | undefined;

  private static readonly LEVELS: readonly AgentAccessLevel[] = Object.freeze(['metadata', 'autofill', 'full']);

  private static readonly OPERATION_FOR_LEVEL: Readonly<Record<AgentAccessLevel, AgentOperation>> = Object.freeze({
    metadata: 'list_metadata',
    autofill: 'autofill',
    full:     'read_secret',
  });

  static readonly MESSAGES = Object.freeze({
    ownerOnly:      'Only the owner can use this item',
    invalidPolicy:  'The agent access policy is invalid',
    agentNotAllowed: 'This agent is not allowed to use this item',
    invalidExpiry:  'The agent access expiry is invalid',
    expired:        'Agent access has expired',
    serverAgents:   'Server agents are not allowed for this item',
    hostRequired:   'A valid destination host is required by this item policy',
    denied:         'Credential policy denied the operation',
  });

  constructor(
    private readonly policy: AgentAccessPolicy = new AgentAccessPolicy(),
    private readonly clock: AgentPolicyGateClock = new SystemAgentPolicyGateClock(),
  ) {}

  static shared(): AgentPolicyGate {
    AgentPolicyGate.sharedInstance ??= new AgentPolicyGate();
    return AgentPolicyGate.sharedInstance;
  }

  allows(policy: AgentPolicy | null | undefined, request: AgentPolicyGateRequest): AgentPolicyGateDecision {
    if (policy?.mode !== 'agents') return this.deny(AgentPolicyGate.MESSAGES.ownerOnly);
    if (!this.wellFormed(policy)) return this.deny(AgentPolicyGate.MESSAGES.invalidPolicy);
    if (!AgentPolicyGate.LEVELS.includes(request.level)) return this.deny(`Agents are limited to ${ policy.level }`);

    let host: string | undefined;
    if (policy.sites.length > 0) {
      host = this.bareHost(request.host);
      if (!host) return this.deny(AgentPolicyGate.MESSAGES.hostRequired);
    }

    const decision = this.policy.decide(this.domainRequest(policy, request, host));
    return decision.allowed ? { allowed: true } : this.deny(this.message(decision, policy, host));
  }

  private wellFormed(policy: AgentPolicy): boolean {
    return AgentPolicyGate.LEVELS.includes(policy.level) &&
      Array.isArray(policy.sites) &&
      (policy.agents === undefined || policy.agents === null || Array.isArray(policy.agents));
  }

  /** Desktop's host rule: a bare hostname only (no port, path or userinfo), lowercased. */
  private bareHost(raw: string | undefined): string | undefined {
    const host = raw?.trim().toLowerCase();
    if (!host) return undefined;
    try {
      return new URL(`https://${ host }`).hostname.toLowerCase() === host ? host : undefined;
    } catch {
      return undefined;
    }
  }

  private domainRequest(policy: AgentPolicy, request: AgentPolicyGateRequest, host: string | undefined): AgentAccessRequest {
    const serverAgent = request.onServer === true;
    return {
      // The item grants up to its policy level; the domain takes min(level, policy.level).
      level:        'full',
      operation:    AgentPolicyGate.OPERATION_FOR_LEVEL[request.level],
      agentId:      request.agentId,
      agentPolicy:  {
        ...policy,
        agents:    [...(policy.agents ?? [])],
        sites:     [...policy.sites],
        // Desktop treats an empty expiry as "never" (the domain would read it as unparseable and refuse).
        expiresAt: policy.expiresAt || null,
      },
      egressTarget: host !== undefined || serverAgent ? { host: host ?? '', serverAgent } : undefined,
      now:          request.now ?? this.clock.now(),
    };
  }

  private message(decision: AgentAccessDecision, policy: AgentPolicy, host: string | undefined): string {
    switch (decision.reason) {
    case 'policy_only_me':
      return AgentPolicyGate.MESSAGES.ownerOnly;
    case 'invalid_policy_level':
      return AgentPolicyGate.MESSAGES.invalidPolicy;
    case 'policy_expired':
      return Number.isFinite(Date.parse(policy.expiresAt ?? '')) ? AgentPolicyGate.MESSAGES.expired : AgentPolicyGate.MESSAGES.invalidExpiry;
    case 'agent_not_allowed':
      return AgentPolicyGate.MESSAGES.agentNotAllowed;
    case 'server_agent_not_allowed':
      return AgentPolicyGate.MESSAGES.serverAgents;
    case 'egress_target_required':
      return AgentPolicyGate.MESSAGES.hostRequired;
    case 'site_not_allowed':
      return `Not allowed on ${ host ?? '' }`;
    case 'insufficient_level':
    case 'access_none':
      return `Agents are limited to ${ policy.level }`;
    default:
      return AgentPolicyGate.MESSAGES.denied;
    }
  }

  private deny(reason: string): AgentPolicyGateDecision {
    return { allowed: false, reason };
  }
}
