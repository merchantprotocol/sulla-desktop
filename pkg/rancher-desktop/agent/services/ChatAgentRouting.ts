import { agentDefinitionService } from './AgentDefinitionService';

import type { BaseThreadState } from '../nodes/Graph';

export const DEFAULT_ROUTE_AGENT_ID = 'sulla';
export const SULLA_DESKTOP_CHANNEL_ID = 'sulla-desktop';
export const DEFAULT_ROUTE_GRAPH_AGENT_ID = SULLA_DESKTOP_CHANNEL_ID;

export interface RoutableAgent {
  /** ID used by Reflex examples and shown in routing receipts. */
  agentId:      string;
  /** Agent ID used to construct the graph. */
  graphAgentId: string;
  name:         string;
}

/** Resolve only enabled, non-archived personas. The built-in Sulla route is always available. */
export async function resolveRoutableAgent(agentId: string): Promise<RoutableAgent | null> {
  const requested = agentId.trim();
  if (!requested) return null;
  if (requested === DEFAULT_ROUTE_AGENT_ID || requested === DEFAULT_ROUTE_GRAPH_AGENT_ID) {
    return { agentId: DEFAULT_ROUTE_AGENT_ID, graphAgentId: DEFAULT_ROUTE_GRAPH_AGENT_ID, name: 'Sulla' };
  }

  const definition = await agentDefinitionService.findBySlug(requested);
  if (!definition || !definition.enabled || definition.status === 'archive') return null;
  return { agentId: definition.slug, graphAgentId: definition.slug, name: definition.name || definition.slug };
}

/** Shared state mutation used by both the route_agent tool and first-message dispatch. */
export function applyThreadAgentRoute(state: BaseThreadState, agent: RoutableAgent): void {
  (state.metadata as any).routedAgentId = agent.graphAgentId;
  (state.metadata as any).routedAgentSourceId = agent.agentId;
}
