/**
 * Whether an AgentNode pass ends the turn. Mirrors the agent graph's exit
 * edge (Graph.ts): done/blocked end it, and so does a wrapper-less reply that
 * made no in-graph tool calls (the edge defaults that to done). continue, or
 * in_progress with tool calls, loops back for another pass.
 */
export function isTerminalAgentTurn(status: string, hadToolCalls: boolean): boolean {
  if (status === 'done' || status === 'blocked') return true;
  return status === 'in_progress' && !hadToolCalls;
}
