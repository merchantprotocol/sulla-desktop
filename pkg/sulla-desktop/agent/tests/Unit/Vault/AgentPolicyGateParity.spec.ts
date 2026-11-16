// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Desktop's vault agent-use check now runs @sulla/domain AgentAccessPolicy through AgentPolicyGate
// (parity ledger D5). These specs prove the switch never widens access: across a matrix of policies and
// requests the gate allows exactly what the legacy agentPolicyAllows allowed, and every single-rule denial
// keeps its message. The few deliberate differences are pinned at the bottom.

import { describe, expect, it } from 'vitest';

import { agentPolicyAllows, type AgentAccessLevel, type AgentPolicy } from '../../../../../../packages/vault-crypto/src/itemSchema';
import { AgentPolicyGate } from '../../../../../../services/sulla-vault/src/localAuthority/AgentPolicyGate';

const policy = (overrides: Partial<AgentPolicy> = {}): AgentPolicy => ({
  mode: 'agents', level: 'full', agents: [], sites: [], expiresAt: null,
  askFirst: false, allowServerAgents: false, ...overrides,
});

const AT = new Date('2026-06-01T00:00:00Z');
const fixedClock = { now: () => AT };
const gate = new AgentPolicyGate(undefined, fixedClock);

type Request = { agentId: string; level: AgentAccessLevel; host?: string; onServer?: boolean; now?: Date };

const POLICIES: Record<string, AgentPolicy | null> = {
  missing:          null,
  onlyMe:           policy({ mode: 'only_me' }),
  open:             policy(),
  metadataOnly:     policy({ level: 'metadata' }),
  autofillOnly:     policy({ level: 'autofill' }),
  listed:           policy({ agents: ['a'] }),
  listedOther:      policy({ agents: ['other'] }),
  expired:          policy({ expiresAt: '2026-05-01T00:00:00Z' }),
  expiresLater:     policy({ expiresAt: '2026-07-01T00:00:00Z' }),
  serverOk:         policy({ allowServerAgents: true }),
  sited:            policy({ sites: ['example.test'] }),
  sitedServer:      policy({ sites: ['example.test'], allowServerAgents: true, level: 'autofill' }),
  badSites:         policy({ sites: 'example.test' as never }),
  badLevel:         policy({ level: 'admin' as never }),
  badExpiry:        policy({ expiresAt: 'soon' }),
  emptyExpiry:      policy({ expiresAt: '' }),
};

const REQUESTS: Record<string, Request> = {
  metadata:      { agentId: 'a', level: 'metadata', now: AT },
  autofill:      { agentId: 'a', level: 'autofill', now: AT },
  full:          { agentId: 'a', level: 'full', now: AT },
  noAgent:       { agentId: '', level: 'metadata', now: AT },
  otherAgent:    { agentId: 'b', level: 'metadata', now: AT },
  server:        { agentId: 'a', level: 'autofill', onServer: true, now: AT },
  goodHost:      { agentId: 'a', level: 'autofill', host: 'login.example.test', now: AT },
  upperHost:     { agentId: 'a', level: 'autofill', host: ' Login.EXAMPLE.test ', now: AT },
  badHost:       { agentId: 'a', level: 'autofill', host: 'attacker.test', now: AT },
  suffixHost:    { agentId: 'a', level: 'autofill', host: 'badexample.test', now: AT },
  portHost:      { agentId: 'a', level: 'autofill', host: 'example.test:443', now: AT },
  pathHost:      { agentId: 'a', level: 'autofill', host: 'example.test/x', now: AT },
  serverGoodHost: { agentId: 'a', level: 'autofill', host: 'example.test', onServer: true, now: AT },
};

describe('AgentPolicyGate matches the legacy Desktop check', () => {
  // risk: authorization / secret disclosure — the domain switch must not allow anything Desktop refused,
  // nor break any use Desktop allowed.
  for (const [policyName, itemPolicy] of Object.entries(POLICIES)) {
    for (const [requestName, request] of Object.entries(REQUESTS)) {
      it(`${ policyName } × ${ requestName }: same allow/deny`, () => {
        expect(gate.allows(itemPolicy, request).allowed).toBe(agentPolicyAllows(itemPolicy, request).allowed);
      });
    }
  }

  it('keeps the legacy message for every single-rule denial', () => {
    const cases: [AgentPolicy | null, Request][] = [
      [POLICIES.missing, REQUESTS.metadata],
      [POLICIES.onlyMe, REQUESTS.metadata],
      [POLICIES.metadataOnly, REQUESTS.full],
      [POLICIES.listedOther, REQUESTS.metadata],
      [POLICIES.listed, REQUESTS.noAgent],
      [POLICIES.expired, REQUESTS.metadata],
      [POLICIES.badExpiry, REQUESTS.metadata],
      [POLICIES.open, REQUESTS.server],
      [POLICIES.sited, REQUESTS.badHost],
      [POLICIES.sited, REQUESTS.suffixHost],
      [POLICIES.sited, REQUESTS.portHost],
      [POLICIES.sited, REQUESTS.metadata],
      [POLICIES.badSites, REQUESTS.metadata],
      [POLICIES.badLevel, REQUESTS.metadata],
    ];
    for (const [itemPolicy, request] of cases) {
      const legacy = agentPolicyAllows(itemPolicy, request);
      expect(legacy.allowed).toBe(false);
      expect(gate.allows(itemPolicy, request)).toEqual(legacy);
    }
  });

  it('allows with the same bare result the callers expect', () => {
    expect(gate.allows(POLICIES.sited, REQUESTS.upperHost)).toEqual({ allowed: true });
    expect(gate.allows(POLICIES.listed, REQUESTS.full)).toEqual({ allowed: true });
  });
});

describe('AgentPolicyGate: now default', () => {
  // risk: authorization — an expired grant must stop working when the caller passes no time.
  it('uses its clock when the request has no now', () => {
    const expiresAtClock = new AgentPolicyGate(undefined, { now: () => new Date('2026-07-01T00:00:00Z') });
    expect(expiresAtClock.allows(POLICIES.expiresLater, { agentId: 'a', level: 'full' }))
      .toEqual({ allowed: false, reason: 'Agent access has expired' });
    expect(gate.allows(POLICIES.expiresLater, { agentId: 'a', level: 'full' })).toEqual({ allowed: true });
  });

  it('prefers the request time over the clock', () => {
    expect(gate.allows(POLICIES.expiresLater, { agentId: 'a', level: 'full', now: new Date('2026-07-01T00:00:00Z') }).allowed)
      .toBe(false);
  });

  it('defaults to the system clock', () => {
    const live = new AgentPolicyGate();
    expect(live.allows(policy({ expiresAt: new Date(Date.now() - 60_000).toISOString() }), { agentId: 'a', level: 'full' }).allowed).toBe(false);
    expect(live.allows(policy({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), { agentId: 'a', level: 'full' }).allowed).toBe(true);
  });
});

describe('AgentPolicyGate: deliberate differences from the legacy copy', () => {
  // risk: authorization — these are the only places the domain switch changes a result or a message.
  it('reports the domain check order when several rules fail (still denied)', () => {
    const everything = policy({ agents: ['other'], level: 'metadata', expiresAt: '2026-05-01T00:00:00Z', sites: ['example.test'] });
    const request: Request = { agentId: 'a', level: 'full', onServer: true, host: 'attacker.test', now: AT };
    expect(agentPolicyAllows(everything, request).reason).toBe('This agent is not allowed to use this item');
    expect(gate.allows(everything, request)).toEqual({ allowed: false, reason: 'Agent access has expired' });
  });

  it('ignores a trailing dot and a stored scheme/path on a site, like the domain', () => {
    expect(agentPolicyAllows(policy({ sites: ['https://example.test/login'] }), REQUESTS.goodHost).allowed).toBe(false);
    expect(gate.allows(policy({ sites: ['https://example.test/login'] }), REQUESTS.goodHost)).toEqual({ allowed: true });
    expect(gate.allows(policy({ sites: ['example.test'] }), { ...REQUESTS.goodHost, host: 'login.example.test.' })).toEqual({ allowed: true });
  });

  it('still refuses look-alike hosts after normalization', () => {
    expect(gate.allows(policy({ sites: ['https://example.test/'] }), REQUESTS.suffixHost).allowed).toBe(false);
    expect(gate.allows(policy({ sites: ['example.test.'] }), REQUESTS.badHost).allowed).toBe(false);
  });

  it('refuses an unknown requested level instead of allowing it', () => {
    const unknown = { agentId: 'a', level: 'root' as AgentAccessLevel, now: AT };
    expect(agentPolicyAllows(policy(), unknown).allowed).toBe(true);
    expect(gate.allows(policy(), unknown).allowed).toBe(false);
  });
});
