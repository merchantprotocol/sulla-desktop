/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AgentTeamFields from '@pkg/components/studio/AgentTeamFields.vue';
import type { AgentModelTiers } from '@pkg/agent/languagemodels/agentModelTiers';
import type { AgentModelChoice } from '@pkg/agent/languagemodels/modelRoutingTypes';

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
function agent(slug: string, canCall: string[] = [], enabled = true) {
  return { id: `id-${ slug }`, slug, name: slug.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' '), description: `${ slug } description`, enabled, status: 'production', canCall, modelChoice: { mode: 'class', class: 'standard' } satisfies AgentModelChoice };
}
function drafts(agents: ReturnType<typeof agent>[]): Record<string, { choice: AgentModelChoice; savedTiers: AgentModelTiers | null; tiers: AgentModelTiers | null }> {
  return Object.fromEntries(agents.map(row => [row.slug, { choice: row.modelChoice, savedTiers: null, tiers: null }]));
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
    const caption = (name: string) => wrapper.findAll('.team-row').find(button => button.text().startsWith(name))!.find('small').text();
    expect(caption('Designer')).toBe('Mockup, when UI design is needed');
    expect(caption('Coding Manager')).toBe('Build and review lead');
    expect(caption('Ui Test Manager')).toBe('Acceptance and break-it checks');
    const branch = (title: string) => wrapper.findAll('details.branch').find(details => details.find('summary').text().includes(title))!;
    expect(branch('Implementation and independent review').text()).toContain('Coding Manager chooses an eligible specialist');
    expect(branch('Implementation and independent review').findAll('.team-row').map(row => row.find('strong').text())).toEqual(['Builder', 'Advisor']);
    expect(branch('Acceptance support').findAll('.team-row').map(row => row.find('strong').text())).toEqual(['Lookup']);
  });

  it('leaves out workers of a coordinator the Product Owner cannot hand off to, and names each lead by its role', () => {
    // Coding Manager exists and is enabled, but it is not on this Product Owner's team.
    const agents = [
      agent('account-manager', ['ui-test-manager', 'director']), agent('coding-manager', ['builder']), agent('builder'),
      agent('ui-test-manager', ['lookup']), agent('lookup'), agent('director'),
    ];
    const wrapper = mount(AgentTeamFields, { props: { owner: agents[0], agents, routing: routing as any, drafts: drafts(agents) } });
    const rows = wrapper.findAll('.team-row').map(row => row.find('strong').text());

    expect(rows.sort()).toEqual(['Director', 'Lookup', 'Ui Test Manager']); // risk: editing a route no handoff can reach
    expect(wrapper.text()).not.toContain('Implementation and independent review');
    expect(wrapper.text()).toContain('3 reachable');
    // With Designer and Coding Manager absent, the tester is first in the list. It is still the acceptance lead.
    const tester = wrapper.findAll('.team-row').find(row => row.text().startsWith('Ui Test Manager'))!;
    expect(tester.find('small').text()).toBe('Acceptance and break-it checks');
    expect(wrapper.text()).toContain('Ui Test Manager can delegate supporting checks');
  });

  it('drops a disabled coordinator’s branch while keeping workers the Product Owner can call directly', () => {
    const agents = [
      agent('account-manager', ['coding-manager', 'ui-test-manager', 'advisor']), agent('coding-manager', ['builder', 'advisor'], false),
      agent('builder'), agent('advisor'), agent('ui-test-manager', ['lookup']), agent('lookup'),
    ];
    const wrapper = mount(AgentTeamFields, { props: { owner: agents[0], agents, routing: routing as any, drafts: drafts(agents) } });
    const rows = wrapper.findAll('.team-row').map(row => row.find('strong').text());

    expect(rows.sort()).toEqual(['Advisor', 'Lookup', 'Ui Test Manager']);
    expect(wrapper.text()).not.toContain('Implementation and independent review');
    expect(wrapper.text()).toContain('3 reachable · 1 unavailable');
    expect(wrapper.find('details.unavailable').exists()).toBe(true);
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
