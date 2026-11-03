/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { jest } from '@jest/globals';

function agent(overrides: { slug: string } & Record<string, unknown>) {
  return {
    name: overrides.slug, description: '', when_to_call: '', when_not_to_call: '', send: '', returns: '',
    cost_tier: null, can_call: [] as string[], front_door: false, provider: null, model: null, model_slot: null,
    is_builtin: true, enabled: true, status: 'production',
    ...overrides,
  };
}

// account-manager ships with a wildcard can_call; new-specialist is "newly
// installed" after that card was last written (no reseed happened).
const ACCOUNT_MANAGER = agent({ slug: 'account-manager', can_call: ['*'] });
const DIRECTOR = agent({ slug: 'director' });
const NEW_SPECIALIST = agent({ slug: 'new-specialist' });
const DISABLED_WORKER = agent({ slug: 'disabled-worker', enabled: false });
const ARCHIVED_WORKER = agent({ slug: 'archived-worker', status: 'archive' });

const AGENTS = [ACCOUNT_MANAGER, DIRECTOR, NEW_SPECIALIST, DISABLED_WORKER, ARCHIVED_WORKER];

jest.unstable_mockModule('../AgentDefinitionService', () => ({
  agentDefinitionService: {
    list:       async() => AGENTS,
    findBySlug: async(slug: string) => AGENTS.find(a => a.slug === slug) ?? null,
  },
}));

const { buildAgentTeamBlock, listAgentDirectory, CAN_CALL_WILDCARD } = await import('../AgentDirectoryService');

describe('can_call wildcard resolution', () => {
  it('is the literal "*"', () => {
    expect(CAN_CALL_WILDCARD).toBe('*');
  });

  it('listAgentDirectory({slugs: ["*"]}) returns every active agent, including one added after the card was written', async() => {
    const cards = await listAgentDirectory({ slugs: ['*'] });
    const slugs = cards.map(card => card.slug);

    expect(slugs).toEqual(expect.arrayContaining(['account-manager', 'director', 'new-specialist']));
    expect(slugs).not.toContain('disabled-worker');
    expect(slugs).not.toContain('archived-worker');
  });

  it('buildAgentTeamBlock resolves the wildcard for a lead and excludes the lead itself', async() => {
    const block = await buildAgentTeamBlock({ forAgentSlug: 'account-manager' });

    expect(block).toContain('director');
    expect(block).toContain('new-specialist');
    expect(block).not.toMatch(/\*\*account-manager\*\*/);
    expect(block).not.toContain('disabled-worker');
    expect(block).not.toContain('archived-worker');
  });

  it('a literal can_call list is left untouched (no wildcard, no expansion)', async() => {
    const cards = await listAgentDirectory({ slugs: ['director'] });
    expect(cards.map(card => card.slug)).toEqual(['director']);
  });
});
