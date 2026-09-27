/**
 * Cross-process routing for background sub-agent completions.
 *
 * A parent AgentGraph can live in the renderer while spawn_agent runs there,
 * too. In that case a normal user_message sent through the IPC bridge is
 * deliberately not echoed back to the sending renderer. Use an explicit
 * renderer-targeted wake so the exact parent graph receives the completion.
 */

export const AGENT_GRAPH_WAKE_TYPE = 'agent_graph_wake' as const;

export type AgentGraphWakeRoute = 'main' | 'renderer';

export function parentGraphWakeRoute(processType?: string): AgentGraphWakeRoute {
  const currentProcessType = processType ??
    (typeof process !== 'undefined' ? String((process as any).type || '') : '');
  return currentProcessType === 'browser' ? 'main' : 'renderer';
}

export function parentGraphWakeMessageType(processType?: string): 'user_message' | typeof AGENT_GRAPH_WAKE_TYPE {
  return parentGraphWakeRoute(processType) === 'renderer' ? AGENT_GRAPH_WAKE_TYPE : 'user_message';
}

export function isRendererTargetedAgentGraphWake(message: any): boolean {
  return message?.type === AGENT_GRAPH_WAKE_TYPE &&
    message?.data?.metadata?.dispatchTarget === 'renderer';
}
