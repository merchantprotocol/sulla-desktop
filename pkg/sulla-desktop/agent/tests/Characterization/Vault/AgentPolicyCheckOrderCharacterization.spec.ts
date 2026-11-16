// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Pins the legacy Desktop agent-policy check (packages/vault-crypto agentPolicyAllows) before the
// switch to @sulla/domain AgentAccessPolicy (parity ledger D5): check order, the `now` default and
// host normalization. AgentPolicyGateParity.spec.ts compares the domain-backed gate against this.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentPolicyAllows, type AgentPolicy } from '../../../../../../packages/vault-crypto/src/itemSchema';

const policy = (overrides: Partial<AgentPolicy> = {}): AgentPolicy => ({
  mode: 'agents', level: 'full', agents: [], sites: [], expiresAt: null,
  askFirst: false, allowServerAgents: false, ...overrides,
});

const PAST = '2026-01-01T00:00:00Z';
const AT = new Date('2026-06-01T00:00:00Z');

describe('legacy agentPolicyAllows: check order', () => {
  // risk: authorization — which rule wins decides the reason the owner sees; every case must deny.
  it('reports owner-only before anything else', () => {
    expect(agentPolicyAllows(policy({ mode: 'only_me', level: 'nope' as never, agents: ['x'] }), { agentId: 'a', level: 'full' }))
      .toEqual({ allowed: false, reason: 'Only the owner can use this item' });
    expect(agentPolicyAllows(null, { agentId: 'a', level: 'metadata' }))
      .toEqual({ allowed: false, reason: 'Only the owner can use this item' });
    expect(agentPolicyAllows({ ...policy(), mode: undefined } as never, { agentId: 'a', level: 'metadata' }))
      .toEqual({ allowed: false, reason: 'Only the owner can use this item' });
  });

  it('reports a malformed policy before the agent list', () => {
    expect(agentPolicyAllows(policy({ sites: 'example.test' as never, agents: ['x'] }), { agentId: 'a', level: 'metadata' }))
      .toEqual({ allowed: false, reason: 'The agent access policy is invalid' });
    expect(agentPolicyAllows(policy({ agents: 'a' as never }), { agentId: 'a', level: 'metadata' }))
      .toEqual({ allowed: false, reason: 'The agent access policy is invalid' });
  });

  it('agent list -> level -> expiry -> server -> sites', () => {
    const everything = policy({
      agents: ['other'], level: 'metadata', expiresAt: PAST, allowServerAgents: false, sites: ['example.test'],
    });
    const req = { agentId: 'a', level: 'full' as const, onServer: true, host: 'attacker.test', now: AT };
    expect(agentPolicyAllows(everything, req).reason).toBe('This agent is not allowed to use this item');
    expect(agentPolicyAllows({ ...everything, agents: [] }, req).reason).toBe('Agents are limited to metadata');
    expect(agentPolicyAllows({ ...everything, agents: [], level: 'full' }, req).reason).toBe('Agent access has expired');
    expect(agentPolicyAllows({ ...everything, agents: [], level: 'full', expiresAt: null }, req).reason)
      .toBe('Server agents are not allowed for this item');
    expect(agentPolicyAllows({ ...everything, agents: [], level: 'full', expiresAt: null, allowServerAgents: true }, req).reason)
      .toBe('Not allowed on attacker.test');
  });

  it('an empty or absent agent list allows every agent; a listed agent passes', () => {
    expect(agentPolicyAllows(policy({ agents: [] }), { agentId: 'a', level: 'full' })).toEqual({ allowed: true });
    expect(agentPolicyAllows({ ...policy(), agents: null } as never, { agentId: 'a', level: 'full' })).toEqual({ allowed: true });
    expect(agentPolicyAllows(policy({ agents: ['a'] }), { agentId: 'a', level: 'full' })).toEqual({ allowed: true });
    expect(agentPolicyAllows(policy({ agents: ['a'] }), { agentId: '', level: 'full' }).allowed).toBe(false);
  });
});

describe('legacy agentPolicyAllows: now default and expiry', () => {
  afterEach(() => vi.useRealTimers());

  // risk: authorization — an expired grant must stop working without the caller passing a clock.
  it('uses the current time when no now is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    expect(agentPolicyAllows(policy({ expiresAt: '2026-05-31T23:59:59Z' }), { agentId: 'a', level: 'full' }).reason)
      .toBe('Agent access has expired');
    expect(agentPolicyAllows(policy({ expiresAt: '2026-06-01T00:00:01Z' }), { agentId: 'a', level: 'full' })).toEqual({ allowed: true });
  });

  it('expires at exactly the expiry instant', () => {
    expect(agentPolicyAllows(policy({ expiresAt: PAST }), { agentId: 'a', level: 'full', now: new Date(PAST) }).reason)
      .toBe('Agent access has expired');
  });

  it('refuses an unparseable expiry and treats an empty one as never', () => {
    expect(agentPolicyAllows(policy({ expiresAt: 'soon' }), { agentId: 'a', level: 'full', now: AT }).reason)
      .toBe('The agent access expiry is invalid');
    expect(agentPolicyAllows(policy({ expiresAt: '' }), { agentId: 'a', level: 'full', now: AT })).toEqual({ allowed: true });
  });
});

describe('legacy agentPolicyAllows: host normalization', () => {
  const sited = policy({ sites: ['Example.Test'] });
  const host = (h: string | undefined) => agentPolicyAllows(sited, { agentId: 'a', level: 'autofill', host: h });

  // risk: credential egress — a credential must only leave for the owner's named sites.
  it('trims and lowercases the host, and matches subdomains', () => {
    expect(host('  LOGIN.Example.TEST ')).toEqual({ allowed: true });
    expect(host('example.test')).toEqual({ allowed: true });
  });

  it('refuses a missing host, a port, a path, userinfo and a look-alike suffix', () => {
    const required = 'A valid destination host is required by this item policy';
    expect(host(undefined).reason).toBe(required);
    expect(host('   ').reason).toBe(required);
    expect(host('example.test:443').reason).toBe(required);
    expect(host('example.test/path').reason).toBe(required);
    expect(host('user@example.test').reason).toBe(required);
    expect(host('badexample.test').reason).toBe('Not allowed on badexample.test');
  });

  it('needs no host when the item names no sites', () => {
    expect(agentPolicyAllows(policy(), { agentId: 'a', level: 'autofill' })).toEqual({ allowed: true });
  });
});
