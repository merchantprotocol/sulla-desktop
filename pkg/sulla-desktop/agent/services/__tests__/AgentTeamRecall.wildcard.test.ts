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
    system_prompt: '', prompt_content: '', prompt_files: {},
    ...overrides,
  };
}

// Carries its own "Calling your team" heading, like the real built-in prompt,
// so the shared section isn't prepended and the char-cap check below is only
// measuring the directory list itself.
const ACCOUNT_MANAGER = agent({ slug: 'account-manager', can_call: ['*'], system_prompt: '## Calling your team\n...' });
const DIRECTOR = agent({ slug: 'director' });
const NEW_SPECIALIST = agent({ slug: 'new-specialist' });
const ARCHIVED_WORKER = agent({ slug: 'archived-worker', status: 'archive' });

const AGENTS = [ACCOUNT_MANAGER, DIRECTOR, NEW_SPECIALIST, ARCHIVED_WORKER];

jest.unstable_mockModule('../AgentDefinitionService', () => ({
  agentDefinitionService: {
    list:       async() => AGENTS,
    findBySlug: async(slug: string) => AGENTS.find(a => a.slug === slug) ?? null,
  },
}));

const { buildTeamRecallContext, depthBudgetLine } = await import('../AgentTeamRecall');

describe('Team directory recall with a can_call wildcard', () => {
  it('scopes the wildcard lead to every other active agent, not the archived one', async() => {
    const directory = await buildTeamRecallContext({ agentSlug: 'account-manager', text: '' });

    expect(directory).toContain('director');
    expect(directory).toContain('new-specialist');
    expect(directory).not.toContain('archived-worker');
    expect(directory).not.toMatch(/\*\*account-manager\*\*/);
  });

  it('stays within its char cap even with many wildcard-resolved agents', async() => {
    const many = Array.from({ length: 80 }, (_, i) => agent({
      slug: `specialist-${ i }`,
      when_to_call: `Handles a specific slice of work for situation number ${ i } on this install`,
    }));
    AGENTS.push(...many);
    try {
      const directory = await buildTeamRecallContext({ agentSlug: 'account-manager', text: '' });
      expect(directory.length).toBeLessThanOrEqual(3500);
      expect(directory).toContain('more: `sulla agents/directory`');
    } finally {
      AGENTS.length = 4;
    }
  });

  describe('depth budget line', () => {
    it('reports remaining levels under the cap', () => {
      expect(depthBudgetLine(0)).toBe('You are at sub-agent depth 0 of 3; you can launch 3 more levels.');
      expect(depthBudgetLine(2)).toBe('You are at sub-agent depth 2 of 3; you can launch 1 more level.');
    });

    it('says it cannot launch sub-agents at the cap', () => {
      expect(depthBudgetLine(3)).toBe('You are at sub-agent depth 3 of 3; you cannot launch sub-agents (max depth reached).');
    });

    it('is injected into the Team directory header when a depth is given', async() => {
      const directory = await buildTeamRecallContext({ agentSlug: 'account-manager', text: '', depth: 3 });
      expect(directory).toContain('you cannot launch sub-agents');

      const noDepth = await buildTeamRecallContext({ agentSlug: 'account-manager', text: '' });
      expect(noDepth).not.toContain('sub-agent depth');
    });
  });
});
