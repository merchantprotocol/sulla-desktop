// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { AgentRecallSuggester } from './AgentUseCaseRecallQuery';
import { AgentUseCaseRecallQuery, registerAgentUseCaseRecallQuery } from './AgentUseCaseRecallQuery';

describe('AgentUseCaseRecallQuery', () => {
  it('passes type and allowlist filters to the index and defensively excludes disallowed results', async() => {
    // risk: permission boundary — team recall cannot return agents outside can_call
    const suggest = vi.fn<AgentRecallSuggester['suggest']>(async() => [
      { type: 'agent' as const, slug: 'allowed', title: 'Allowed', description: 'A', score: 0.03, reason: 'semantic match' },
      { type: 'agent' as const, slug: 'forbidden', title: 'Forbidden', description: 'B', score: 0.02, reason: 'semantic match' },
      { type: 'skill' as const, slug: 'skill', title: 'Skill', description: 'C', score: 0.01, reason: 'semantic match' },
    ]);
    const query = new AgentUseCaseRecallQuery({ suggest });
    const response = await query.query('delegate task', { types: ['agent'], allowedSlugs: ['allowed'], limit: 100 });
    expect(suggest).toHaveBeenCalledWith('delegate task', { types: ['agent'], allowedSlugs: ['allowed'], limit: 50 });
    expect(response.items.map(row => row.slug)).toEqual(['allowed']);
  });

  it('sanitizes categories and caps results before querying, without truncating the allowlist', async() => {
    // risk: unbounded candidate request — recall is limited to the intended safe category and result cap
    const suggest = vi.fn<AgentRecallSuggester['suggest']>(async() => []);
    const query = new AgentUseCaseRecallQuery({ suggest });
    const rows = Array.from({ length: 55 }, (_, index) => `agent-${index}`);
    await query.query('find a team', { types: ['workflow', 'agent'] as any, allowedSlugs: rows, limit: 500, minScore: 1.5 });
    expect(suggest).toHaveBeenCalledWith('find a team', { types: ['agent'], allowedSlugs: rows, limit: 50, minScore: 1 });
  });

  it('keeps the strongest allowed agent even when it sits beyond the first 50 allowlist entries', async() => {
    // risk: permission boundary + ranking — truncating the allowlist before ranking silently hid valid callees
    const rows = Array.from({ length: 55 }, (_, index) => `agent-${index}`);
    const suggest = vi.fn<AgentRecallSuggester['suggest']>(async() => [
      { type: 'agent' as const, slug: 'agent-54', title: 'Best', description: 'D', score: 0.9, reason: 'semantic match' },
      { type: 'agent' as const, slug: 'agent-3', title: 'Other', description: 'E', score: 0.2, reason: 'semantic match' },
    ]);
    const query = new AgentUseCaseRecallQuery({ suggest });
    const response = await query.query('deploy', { types: ['agent'], allowedSlugs: rows });
    expect(suggest.mock.calls[0][1].allowedSlugs).toHaveLength(55);
    expect(response.items.map(row => row.slug)).toEqual(['agent-54', 'agent-3']);
  });

  it('rejects overlimit, empty, or malformed allowlists instead of querying unrestricted', async() => {
    // risk: empty-allowlist bypass — a provided but unusable allowlist must never widen to all agents
    const suggest = vi.fn<AgentRecallSuggester['suggest']>(async() => [
      { type: 'agent' as const, slug: 'anything', title: 'Any', description: 'F', score: 0.9, reason: 'semantic match' },
    ]);
    const query = new AgentUseCaseRecallQuery({ suggest });
    const overlimit = Array.from({ length: 2001 }, (_, index) => `agent-${index}`);
    const bad: unknown[][] = [[], overlimit, ['*'], ['bad slug'], [42], ['../etc'], ['ok', ''] ];
    for (const allowedSlugs of bad) {
      expect(await query.query('deploy', { types: ['agent'], allowedSlugs: allowedSlugs as string[] })).toEqual({ items: [], ms: 0 });
    }
    expect(suggest).not.toHaveBeenCalled();
  });

  it('accepts a full 2000-slug allowlist', async() => {
    // risk: permission boundary — the documented ceiling must still work
    const suggest = vi.fn<AgentRecallSuggester['suggest']>(async() => []);
    const query = new AgentUseCaseRecallQuery({ suggest });
    const rows = Array.from({ length: 2000 }, (_, index) => `agent-${index}`);
    await query.query('deploy', { types: ['agent'], allowedSlugs: rows });
    expect(suggest.mock.calls[0][1].allowedSlugs).toHaveLength(2000);
  });

  it('registers a separate recall channel and returns no rows for blank prompts', async() => {
    // risk: empty messages should not trigger embeddings or expose unrelated use cases
    const suggest = vi.fn<AgentRecallSuggester['suggest']>(async() => []);
    const register = vi.fn();
    registerAgentUseCaseRecallQuery(register, { suggest });
    expect(register).toHaveBeenCalledWith('use-case-recall:query', expect.any(Function));
    const handler = register.mock.calls[0][1] as (_event: unknown, text: unknown, options: any) => Promise<{ items: unknown[] }>;
    expect(await handler({}, '  ', { types: ['skill'] })).toEqual({ items: [], ms: 0 });
    expect(suggest).not.toHaveBeenCalled();
  });
});
