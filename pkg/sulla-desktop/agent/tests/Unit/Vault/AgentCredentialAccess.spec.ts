// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { AgentCredentialAccess } from '../../../services/vaultAccessPolicy';

// The level agent tools (vault list/read/autofill, function env) give one agent
// for a stored llm_access value. Owner decision 2026-11-11: an empty or absent
// agent list allows every agent; a non-empty list allows only the listed ones.
describe('AgentCredentialAccess', () => {
  const access = new AgentCredentialAccess();

  it('keeps the human-set level for a listed agent', () => {
    // risk: availability — the chosen agent must keep its access.
    expect(access.levelFor({ storedLevel: 'full', agentId: 'research-agent', agents: ['research-agent'] })).toBe('full');
  });

  it('gives an unlisted agent no access', () => {
    // risk: secret disclosure — a credential restricted to one agent must stay hidden from others.
    expect(access.levelFor({ storedLevel: 'full', agentId: 'coding-agent', agents: ['research-agent'] })).toBe('none');
    expect(access.levelFor({ storedLevel: 'autofill', agentId: '', agents: ['research-agent'] })).toBe('none');
  });

  it('allows every agent when the list is empty or absent', () => {
    // risk: availability — empty or missing means all agents.
    expect(access.levelFor({ storedLevel: 'metadata', agentId: 'coding-agent', agents: [] })).toBe('metadata');
    expect(access.levelFor({ storedLevel: 'full', agentId: 'coding-agent' })).toBe('full');
    expect(access.levelFor({ storedLevel: 'full', agentId: 'coding-agent', agents: null })).toBe('full');
  });

  it('never widens none and fails unknown values to autofill', () => {
    // risk: authorization — the allow-list must not raise a human restriction.
    expect(access.levelFor({ storedLevel: 'none', agentId: 'research-agent', agents: ['research-agent'] })).toBe('none');
    expect(access.levelFor({ storedLevel: 'surprise', agentId: 'coding-agent' })).toBe('autofill');
    expect(access.levelFor({ storedLevel: undefined, agentId: 'coding-agent' })).toBe('autofill');
  });
});
