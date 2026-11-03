/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import {
  calledBy, costLabel, filterAgents, groupAgents, hasRoutingCard, isManager, matchesQuery, modelLabel, type DirectoryAgent,
} from '../agentDirectory';

function agent(overrides: Partial<DirectoryAgent> = {}): DirectoryAgent {
  return {
    id: 'id-' + (overrides.slug ?? 'agent'),
    slug: 'agent',
    name: 'Agent',
    description: 'Does things.',
    provider: null,
    model: null,
    modelSlot: null,
    prompt: '',
    sourceKind: 'local',
    marketplaceVersion: null,
    status: 'production',
    enabled: true,
    runLocation: 'container',
    whenToCall: '',
    whenNotToCall: '',
    send: '',
    returns: '',
    costTier: null,
    canCall: [],
    isBuiltin: false,
    frontDoor: null,
    type: null,
    ...overrides,
  };
}

describe('isManager', () => {
  it('is a manager when it can call other agents', () => {
    expect(isManager(agent({ canCall: ['worker-a'] }))).toBe(true);
  });

  it('is a manager when config.type is lead, even with no can_call', () => {
    expect(isManager(agent({ canCall: [], type: 'lead' }))).toBe(true);
  });

  it('is a manager when config.type is planner', () => {
    expect(isManager(agent({ canCall: [], type: 'planner' }))).toBe(true);
  });

  it('is a worker otherwise', () => {
    expect(isManager(agent({ canCall: [], type: 'worker' }))).toBe(false);
    expect(isManager(agent({ canCall: [], type: null }))).toBe(false);
  });
});

describe('hasRoutingCard', () => {
  it('is false for an empty or whitespace-only when_to_call', () => {
    expect(hasRoutingCard(agent({ whenToCall: '' }))).toBe(false);
    expect(hasRoutingCard(agent({ whenToCall: '   ' }))).toBe(false);
  });

  it('is true once when_to_call has content', () => {
    expect(hasRoutingCard(agent({ whenToCall: 'When the human asks for X' }))).toBe(true);
  });
});

describe('calledBy', () => {
  const lead = agent({ slug: 'lead', canCall: ['worker-a'] });
  const everyone = agent({ slug: 'content-specialist', canCall: ['*'] });
  const workerA = agent({ slug: 'worker-a', canCall: [] });
  const workerB = agent({ slug: 'worker-b', canCall: [] });
  const roster = [lead, everyone, workerA, workerB];

  it('finds every agent whose can_call names this slug', () => {
    expect(calledBy(roster, 'worker-a').map(a => a.slug).sort()).toEqual(['content-specialist', 'lead']);
  });

  it('counts a wildcard can_call as calling everyone', () => {
    expect(calledBy(roster, 'worker-b').map(a => a.slug)).toEqual(['content-specialist']);
  });

  it('never lists an agent as calling itself', () => {
    expect(calledBy(roster, 'content-specialist').map(a => a.slug)).not.toContain('content-specialist');
  });

  it('is empty when no one calls this agent', () => {
    // No agent here has a wildcard can_call, so "lonely" is genuinely uncalled.
    const lonely = agent({ slug: 'lonely' });
    expect(calledBy([lead, workerA, workerB, lonely], 'lonely')).toEqual([]);
  });
});

describe('modelLabel', () => {
  it('prefers a pinned provider/model', () => {
    expect(modelLabel(agent({ provider: 'claude-code', model: 'claude-opus-5-5' }))).toBe('claude-code · claude-opus-5-5');
  });

  it('falls back to the preferences model slot', () => {
    expect(modelLabel(agent({ modelSlot: 'primary' }))).toBe('Primary slot');
  });

  it('shows a dash with neither', () => {
    expect(modelLabel(agent({}))).toBe('—');
  });
});

describe('costLabel', () => {
  it('title-cases a set tier and falls back to "Not set"', () => {
    expect(costLabel('low')).toBe('Low');
    expect(costLabel('high')).toBe('High');
    expect(costLabel(null)).toBe('Not set');
  });
});

describe('matchesQuery', () => {
  const a = agent({
    name: 'Mockup Designer', slug: 'mockup-designer', description: 'Produces review-ready HTML mockups.',
    whenToCall: 'Before building or changing UI', whenNotToCall: 'Wiring UI into the product',
    send: 'Screen and problem to solve', returns: 'One .html file per variation', costTier: 'medium',
  });

  it('matches an empty query', () => {
    expect(matchesQuery(a, '')).toBe(true);
  });

  it('matches by slug', () => {
    expect(matchesQuery(a, 'mockup-designer')).toBe(true);
  });

  it('matches a routing field like when_to_call', () => {
    expect(matchesQuery(a, 'changing ui')).toBe(true);
  });

  it('matches the cost tier label', () => {
    expect(matchesQuery(a, 'medium')).toBe(true);
  });

  it('is case-insensitive and rejects a non-match', () => {
    expect(matchesQuery(a, 'MOCKUP')).toBe(true);
    expect(matchesQuery(a, 'nothing here matches')).toBe(false);
  });
});

describe('filterAgents', () => {
  const mgr = agent({ slug: 'lead', canCall: ['worker'], isBuiltin: true, enabled: true, whenToCall: 'When the human needs this role' });
  const wrk = agent({ slug: 'worker', canCall: [], isBuiltin: true, enabled: true, whenToCall: 'When asked' });
  const custom = agent({ slug: 'custom', canCall: [], isBuiltin: false, enabled: false, whenToCall: '' });
  const roster = [mgr, wrk, custom];

  it('All returns every agent', () => {
    expect(filterAgents(roster, 'all', '', false)).toHaveLength(3);
  });

  it('Managers returns only managers', () => {
    expect(filterAgents(roster, 'mgr', '', false).map(a => a.slug)).toEqual(['lead']);
  });

  it('Workers returns only non-managers', () => {
    expect(filterAgents(roster, 'wrk', '', false).map(a => a.slug).sort()).toEqual(['custom', 'worker']);
  });

  it('Disabled returns only disabled agents', () => {
    expect(filterAgents(roster, 'dis', '', false).map(a => a.slug)).toEqual(['custom']);
  });

  it('the missing-routing-card toggle narrows to agents with no when_to_call', () => {
    expect(filterAgents(roster, 'all', '', true).map(a => a.slug)).toEqual(['custom']);
  });

  it('combines a filter with a search query', () => {
    expect(filterAgents(roster, 'all', 'worker', false).map(a => a.slug)).toEqual(['worker']);
  });
});

describe('groupAgents', () => {
  const mgr = agent({ slug: 'lead', canCall: ['worker'] });
  const wrk = agent({ slug: 'worker', canCall: [] });

  it('splits into Managers/Workers on the default, unfiltered view', () => {
    const groups = groupAgents([mgr, wrk], 'all', '', false);
    expect(groups.map(g => g.title)).toEqual(['Managers', 'Workers']);
    expect(groups[0].agents.map(a => a.slug)).toEqual(['lead']);
    expect(groups[1].agents.map(a => a.slug)).toEqual(['worker']);
  });

  it('omits an empty group', () => {
    const groups = groupAgents([wrk], 'all', '', false);
    expect(groups.map(g => g.title)).toEqual(['Workers']);
  });

  it('collapses into one ungrouped list once a filter, search or missing-only toggle is active', () => {
    // groupAgents receives an already-filtered list; it only decides whether to split it into sections.
    expect(groupAgents([mgr], 'mgr', '', false)).toEqual([{ title: null, hint: null, agents: [mgr] }]);
    expect(groupAgents([mgr], 'all', 'lead', false)).toEqual([{ title: null, hint: null, agents: [mgr] }]);
    expect(groupAgents([mgr, wrk], 'all', '', true)).toEqual([{ title: null, hint: null, agents: [mgr, wrk] }]);
  });
});
