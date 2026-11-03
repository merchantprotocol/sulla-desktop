// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Business logic for the Agents · Directory tab, split out from
 * AgentDirectoryTab.vue so it can be unit tested without mounting Vue.
 * Field names and the manager/worker split match the approved mockup
 * (Projects/sulla-desktop/mockups/agent-directory).
 */

import type { AgentDefinitionResponse } from '@pkg/main/agentsIpc';

export type DirectoryAgent = AgentDefinitionResponse;

export const WILDCARD_CALLEE = '*';

/** can_call isn't empty, or config.type is lead/planner — same as the mockup. */
export function isManager(agent: Pick<DirectoryAgent, 'canCall' | 'type'>): boolean {
  return agent.canCall.length > 0 || agent.type === 'lead' || agent.type === 'planner';
}

/** An empty when_to_call means managers only see the description. */
export function hasRoutingCard(agent: Pick<DirectoryAgent, 'whenToCall'>): boolean {
  return agent.whenToCall.trim() !== '';
}

/** Every other agent whose can_call lists this slug, or calls everyone via "*". */
export function calledBy(agents: DirectoryAgent[], slug: string): DirectoryAgent[] {
  return agents.filter(a => a.slug !== slug && (a.canCall.includes(slug) || a.canCall.includes(WILDCARD_CALLEE)));
}

export function modelLabel(agent: Pick<DirectoryAgent, 'provider' | 'model' | 'modelSlot'>): string {
  if (agent.model) return `${ agent.provider ?? '' } · ${ agent.model }`.replace(/^ · /, '');
  if (agent.modelSlot) return `${ agent.modelSlot[0].toUpperCase() }${ agent.modelSlot.slice(1) } slot`;

  return '—';
}

export function costLabel(tier: DirectoryAgent['costTier']): string {
  return tier ? `${ tier[0].toUpperCase() }${ tier.slice(1) }` : 'Not set';
}

/** Search over name, slug, description and every routing field, plus model and cost tier. */
export function matchesQuery(agent: DirectoryAgent, query: string): boolean {
  const q = query.trim().toLowerCase();

  if (!q) return true;
  const haystack = [
    agent.name, agent.slug, agent.description, agent.whenToCall, agent.whenNotToCall,
    agent.send, agent.returns, modelLabel(agent), agent.costTier ?? '',
  ].join(' ').toLowerCase();

  return haystack.includes(q);
}

export type DirectoryFilterKey = 'all' | 'mgr' | 'wrk' | 'bi' | 'cu' | 'dis';

export const DIRECTORY_FILTERS: { key: DirectoryFilterKey; label: string; test: (a: DirectoryAgent) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'mgr', label: 'Managers', test: isManager },
  { key: 'wrk', label: 'Workers', test: a => !isManager(a) },
  { key: 'bi', label: 'Built-in', test: a => a.isBuiltin },
  { key: 'cu', label: 'Custom', test: a => !a.isBuiltin },
  { key: 'dis', label: 'Disabled', test: a => !a.enabled },
];

export function filterAgents(agents: DirectoryAgent[], filter: DirectoryFilterKey, query: string, missingOnly: boolean): DirectoryAgent[] {
  const test = DIRECTORY_FILTERS.find(f => f.key === filter)?.test ?? (() => true);

  return agents.filter(a => test(a) && (!missingOnly || !hasRoutingCard(a)) && matchesQuery(a, query));
}

export interface DirectoryGroup { title: string | null; hint: string | null; agents: DirectoryAgent[] }

/** Grouped into Managers/Workers only for the unfiltered, unsearched default view. */
export function groupAgents(list: DirectoryAgent[], filter: DirectoryFilterKey, query: string, missingOnly: boolean): DirectoryGroup[] {
  if (filter !== 'all' || query.trim() || missingOnly) return [{ title: null, hint: null, agents: list }];

  return [
    { title: 'Managers', hint: 'plan, route and launch other agents', agents: list.filter(isManager) },
    { title: 'Workers', hint: 'do one job and return a result', agents: list.filter(a => !isManager(a)) },
  ].filter(group => group.agents.length > 0);
}

export function formatUpdated(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;

  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
}
