/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AgentTeamFields, { type AgentTeamMember, type AgentTeamModelDraft } from '@pkg/components/studio/AgentTeamFields.vue';

const candidate = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'medium' };
const tiers = { version: 1 as const, tiers: [{ candidates: [candidate] }], crossCompanyFallback: true, allowLaunchOverride: 'listed' as const };
const routing = {
  workers:        [],
  workerBindings: {},
  providers:      [{
    id:           'codex',
    name:         'OpenAI Codex',
    connected:    true,
    local:        false,
    subscription: true,
    status:       'ready',
    coolingUntil: null,
    lastError:    null,
    models:       [{ id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', efforts: [{ id: 'medium' }, { id: 'high' }] }],
  }],
  agentsList:          [],
  subconsciousList:    [],
  classes:             { frontier: [], standard: [], fast: [], coding: [], local: [] },
  followProviderOrder: {},
  neverUse:            [],
};
function agent(slug: string, canCall: string[] = [], enabled = true): AgentTeamMember {
  return { id: `id-${ slug }`, slug, name: slug.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' '), description: `${ slug } description`, enabled, status: 'production', canCall, modelChoice: { mode: 'class', class: 'standard' } };
}
function drafts(agents: AgentTeamMember[]): Record<string, AgentTeamModelDraft> {
  return Object.fromEntries(agents.map(row => [row.slug, { choice: row.modelChoice!, savedTiers: null, tiers: null }]));
}

describe('agent team fields', () => {
  it('shows every enabled Product Owner delegate across direct and coordinator routes', () => {
    const agents = [
      agent('account-manager', ['*']), agent('designer'), agent('coding-manager', ['builder', 'advisor']),
      agent('builder'), agent('advisor'), agent('ui-test-manager', ['lookup']), agent('lookup'), agent('director'),
      agent('disabled-helper', [], false),
    ];
    const wrapper = mount(AgentTeamFields, { props: { owner: agents[0], agents, routing: routing as any, drafts: drafts(agents) } });
    for (const name of ['Designer', 'Coding Manager', 'Builder', 'Advisor', 'Ui Test Manager', 'Lookup', 'Director']) expect(wrapper.text()).toContain(name);
    for (const row of agents.slice(1, -1)) {
      expect(wrapper.findAll('.team-row').filter(button => button.text().startsWith(row.name)).length, row.slug).toBe(1);
    }
    expect(wrapper.text()).toContain('7 reachable · 1 unavailable');
    expect(wrapper.text()).toContain('Chat choices come first');
  });

  it('walks a coordinator’s explicit delegation graph without looping on cycles', () => {
    const owner = agent('project-manager', ['director']);
    const director = agent('director', ['builder']);
    const builder = agent('builder', ['director']);
    const agents = [owner, director, builder];
    const wrapper = mount(AgentTeamFields, { props: { owner, agents, routing: routing as any, drafts: drafts(agents) } });
    expect(wrapper.text()).toContain('Delegated by Director');
    expect(wrapper.text()).toContain('Builder');
    expect(wrapper.findAll('summary').filter(row => row.text().includes('Delegated by')).length).toBeLessThanOrEqual(2);
  });

  it('shows a worker once when both the owner and a nested coordinator can call it', () => {
    const owner = agent('project-manager', ['director', 'builder']);
    const director = agent('director', ['builder']);
    const builder = agent('builder');
    const agents = [owner, director, builder];
    const wrapper = mount(AgentTeamFields, { props: { owner, agents, routing: routing as any, drafts: drafts(agents) } });
    expect(wrapper.findAll('.team-row').filter(row => row.text().startsWith('Builder')).length).toBe(1);
    expect(wrapper.text()).toContain('2 reachable');
  });

  it('edits the selected member through the existing tier control', async() => {
    const owner = agent('account-manager', ['builder']);
    const builder = agent('builder');
    const modelDrafts = drafts([owner, builder]);
    modelDrafts.builder = { choice: { mode: 'class', class: 'coding' }, savedTiers: tiers, tiers };
    const wrapper = mount(AgentTeamFields, { props: { owner, agents: [owner, builder], routing: routing as any, drafts: modelDrafts } });
    await wrapper.find('[aria-label="Tier 1, model 1 effort"]').setValue('high');
    expect(wrapper.emitted('update-tiers')?.at(-1)).toEqual(['builder', {
      ...tiers, tiers: [{ candidates: [{ ...candidate, effort: 'high' }] }],
    }]);
  });
});
