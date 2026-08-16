/**
 * Canonical reader for a finished sub-agent graph state.
 *
 * After `graph.execute(subState)` returns, both delegation paths derived the
 * same reply the same way — a blocked-status branch, then a
 * finalSummary → last-message → '(no output)' fallback chain. That logic lived
 * in two places (`conversationRunner.runConversationTurn` for persistent
 * multi-turn conversations, `spawn_agent.executeSingle` for fire-and-forget
 * jobs) and had to be kept byte-identical by hand. This is the single source of
 * truth both call.
 *
 * Pure function of `finalState` — it does not touch the graph, the abort
 * service, or the synchronous multi-turn contract. It only turns a settled
 * state into `{ status, text }`; each caller maps that onto its own result
 * shape (TurnResult vs AgentJobResult).
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
