/**
 * Canonical reader for a finished sub-agent graph state.
 *
 * After `graph.execute(subState)` returns, delegation derives the reply through
 * a blocked-status branch and finalSummary → last-message → '(no output)'
 * fallback chain. This is the single source of truth for spawned jobs.
 *
 * Pure function of `finalState` — it does not touch the graph, the abort
 * service, or job lifecycle. It only turns a settled state into
 * `{ status, text }` for AgentJobResult.
 */

export interface AgentTurnOutcome {
  status: 'completed' | 'blocked';
  text:   string;
}

/**
 * Derive the reply text + terminal status from a finished sub-agent graph
 * state. `finalState` is the value resolved by `graph.execute(subState)`.
 */
export function extractAgentTurnOutcome(finalState: any): AgentTurnOutcome {
  const agentMeta    = finalState?.metadata?.agent || {};
  const agentStatus  = String(agentMeta.status || '').toLowerCase();

  if (agentStatus === 'blocked') {
    const blockerReason = agentMeta.blocker_reason || 'Unknown blocker';
    const unblockReqs   = agentMeta.unblock_requirements || '';

    return {
      status: 'blocked',
      text:   `[BLOCKED] ${ blockerReason }${ unblockReqs ? ` | Requirements: ${ unblockReqs }` : '' }`,
    };
  }

  const out = finalState?.metadata?.finalSummary ||
    finalState?.messages?.[finalState.messages.length - 1]?.content ||
    '(no output)';

  return {
    status: 'completed',
    text:   typeof out === 'string' ? out : JSON.stringify(out),
  };
}
