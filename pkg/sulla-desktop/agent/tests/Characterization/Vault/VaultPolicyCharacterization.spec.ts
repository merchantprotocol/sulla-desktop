// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { agentPolicyAllows, type AgentPolicy } from '../../../../../../packages/vault-crypto/src/itemSchema';
import { legacyProviderFailure, providerFailureFromHttp, VaultLocked } from '../../../languagemodels/failures';
import { mayInjectSecretIntoAgentCode, resolveLlmAccess } from '../../../services/vaultAccessPolicy';

const policy = (overrides: Partial<AgentPolicy> = {}): AgentPolicy => ({
  mode: 'agents', level: 'full', agents: [], sites: [], expiresAt: null,
  askFirst: false, allowServerAgents: false, ...overrides,
});

describe('Desktop vault agent policy public contract', () => {
  it('fails closed for owner-only, insufficient, expired, server, and host-scoped access', () => {
    // risk: secret disclosure / authorization.
    expect(agentPolicyAllows(policy({ mode: 'only_me' }), { agentId: 'a', level: 'metadata' }).allowed).toBe(false);
    expect(agentPolicyAllows(policy({ level: 'metadata' }), { agentId: 'a', level: 'full' }).allowed).toBe(false);
    expect(agentPolicyAllows(policy({ expiresAt: '2026-01-01T00:00:00Z' }), {
      agentId: 'a', level: 'metadata', now: new Date('2026-01-01T00:00:00Z'),
    }).allowed).toBe(false);
    expect(agentPolicyAllows(policy(), { agentId: 'a', level: 'metadata', onServer: true }).allowed).toBe(false);
    expect(agentPolicyAllows(policy({ sites: ['example.test'] }), {
      agentId: 'a', level: 'full', host: 'attacker.test',
    }).allowed).toBe(false);
    expect(agentPolicyAllows(policy({ sites: ['example.test'] }), {
      agentId: 'a', level: 'full', host: 'login.example.test',
    })).toEqual({ allowed: true });
  });

  it('never injects metadata-only secrets or autofill website passwords into agent code', () => {
    // risk: secret disclosure — autofill must not become readable output.
    expect(mayInjectSecretIntoAgentCode('website', 'none')).toBe(false);
    expect(mayInjectSecretIntoAgentCode('website', 'metadata')).toBe(false);
    expect(mayInjectSecretIntoAgentCode('website', 'autofill')).toBe(false);
    expect(mayInjectSecretIntoAgentCode('website', 'full')).toBe(true);
    expect(mayInjectSecretIntoAgentCode('github', 'autofill')).toBe(true);
  });

  it('maps unknown and blank legacy access to autofill without widening explicit restrictions', () => {
    // risk: authorization migration.
    expect(resolveLlmAccess(undefined)).toBe('autofill');
    expect(resolveLlmAccess('unexpected')).toBe('autofill');
    expect(resolveLlmAccess('none')).toBe('none');
    expect(resolveLlmAccess('metadata')).toBe('metadata');
    expect(resolveLlmAccess('full')).toBe('full');
  });

  it('BL-007 classifies HTTP and structured vault-locked failures as VaultLocked', () => {
    // risk: authentication recovery — callers depend on instanceof to start the unlock path.
    expect(providerFailureFromHttp('provider', 423)).toBeInstanceOf(VaultLocked);
    expect(legacyProviderFailure('provider', { code: 'vault_locked' })).toBeInstanceOf(VaultLocked);
    expect(legacyProviderFailure('provider', { status: 423 })).toBeInstanceOf(VaultLocked);
  });
});
