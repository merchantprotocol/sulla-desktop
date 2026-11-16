// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentDefinitionService } from './AgentDefinitionService';

import type { BaseThreadState } from '../nodes/Graph';
import type { AgentModelChoice } from '../languagemodels/modelRoutingTypes';

/** The built-in Sulla persona. Always available; the last-resort front door. */
export const SULLA_ROUTE_AGENT_ID = 'sulla';
export const SULLA_DESKTOP_CHANNEL_ID = 'sulla-desktop';
export const DEFAULT_ROUTE_GRAPH_AGENT_ID = SULLA_DESKTOP_CHANNEL_ID;

export interface RoutableAgent {
  /** Agent slug the thread is routed to. */
  agentId:      string;
  /** Agent ID used to construct the graph. */
  graphAgentId: string;
  name:         string;
  modelChoice?: AgentModelChoice;
}

const SULLA_ROUTE: RoutableAgent = { agentId: SULLA_ROUTE_AGENT_ID, graphAgentId: DEFAULT_ROUTE_GRAPH_AGENT_ID, name: 'Sulla' };

export function isSullaRoute(agentId: string): boolean {
  return agentId === SULLA_ROUTE_AGENT_ID || agentId === DEFAULT_ROUTE_GRAPH_AGENT_ID;
}

/** Resolve only enabled, non-archived personas. The built-in Sulla route is always available. */
export async function resolveRoutableAgent(agentId: string): Promise<RoutableAgent | null> {
  const requested = agentId.trim();
  if (!requested) return null;
  if (isSullaRoute(requested)) return { ...SULLA_ROUTE };

  const definition = await agentDefinitionService.findBySlug(requested);
  if (!definition || !definition.enabled || definition.status === 'archive') return null;
  return { agentId: definition.slug, graphAgentId: definition.slug, name: definition.name || definition.slug };
}

/**
 * Where a new chat lands when the human picked no agent: the
 * New chats default (Preferences → AI models → Defaults). An agent default routes to that agent (Sulla
 * if it's gone or turned off); a model default routes to Sulla carrying that model choice for the thread.
 */
export async function resolveDefaultRouteAgent(): Promise<RoutableAgent> {
  try {
    const { getModelDefaults, resolveDefaultChoice } = await import('../languagemodels/modelDefaults');
    const resolved = await resolveDefaultChoice((await getModelDefaults()).chat);
    return { ...resolved.agent, ...(resolved.modelChoice ? { modelChoice: resolved.modelChoice } : {}) };
  } catch (err) {
    console.warn('[ChatAgentRouting] New chats default unavailable; using Sulla:', err);
    return { ...SULLA_ROUTE };
  }
}

/**
 * Shared state mutation used by new-chat default routing. A route that
 * carries a model choice stores it on the thread; any other route clears it, so the new agent's own
 * Model setting applies.
 */
export function applyThreadAgentRoute(state: BaseThreadState, agent: RoutableAgent): void {
  (state.metadata as any).routedAgentId = agent.graphAgentId;
  (state.metadata as any).routedAgentSourceId = agent.agentId;
  if (agent.modelChoice) (state.metadata as any).modelChoice = agent.modelChoice;
  else delete (state.metadata as any).modelChoice;
}
