import { agentDefinitionService } from './AgentDefinitionService';
import { isFrontDoorAgent } from './AgentDirectoryService';

import type { BaseThreadState } from '../nodes/Graph';

/** The built-in Sulla persona. Always available; the last-resort front door. */
export const SULLA_ROUTE_AGENT_ID = 'sulla';
/** Where a new chat lands when Reflex has no confident route. Falls back to Sulla. */
export const DEFAULT_ROUTE_AGENT_ID = 'account-manager';
export const SULLA_DESKTOP_CHANNEL_ID = 'sulla-desktop';
export const DEFAULT_ROUTE_GRAPH_AGENT_ID = SULLA_DESKTOP_CHANNEL_ID;

export interface RoutableAgent {
  /** ID used by Reflex examples and shown in routing receipts. */
  agentId:      string;
  /** Agent ID used to construct the graph. */
  graphAgentId: string;
  name:         string;
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
 * Like resolveRoutableAgent, but only for agents that may take a brand-new
 * chat: enabled, not archived, and marked front-door in the directory. Sulla
 * is always a valid front door.
 */
export async function resolveFrontDoorAgent(agentId: string): Promise<RoutableAgent | null> {
  const requested = agentId.trim();
  if (!requested) return null;
  if (isSullaRoute(requested)) return { ...SULLA_ROUTE };

  const definition = await agentDefinitionService.findBySlug(requested);
  if (!definition || !definition.enabled || definition.status === 'archive' || !isFrontDoorAgent(definition)) return null;
  return { agentId: definition.slug, graphAgentId: definition.slug, name: definition.name || definition.slug };
}

/**
 * The default front door: account-manager when that row exists, is enabled
 * and not explicitly taken off the front door; otherwise Sulla.
 */
export async function resolveDefaultRouteAgent(): Promise<RoutableAgent> {
  try {
    const definition = await agentDefinitionService.findBySlug(DEFAULT_ROUTE_AGENT_ID);
    if (definition && definition.enabled && definition.status !== 'archive' && definition.front_door !== false) {
      return { agentId: definition.slug, graphAgentId: definition.slug, name: definition.name || definition.slug };
    }
  } catch (err) {
    console.warn('[ChatAgentRouting] default route lookup failed; using Sulla:', err instanceof Error ? err.message : err);
  }
  return { ...SULLA_ROUTE };
}

/** Shared state mutation used by both the route_agent tool and first-message dispatch. */
export function applyThreadAgentRoute(state: BaseThreadState, agent: RoutableAgent): void {
  (state.metadata as any).routedAgentId = agent.graphAgentId;
  (state.metadata as any).routedAgentSourceId = agent.agentId;
}
