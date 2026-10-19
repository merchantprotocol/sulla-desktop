export interface InvocationState { agentInvocationCounts?: Record<string, number> }

export function agentOccurrence(state: InvocationState, nodeId: string): number {
  const value = state.agentInvocationCounts?.[nodeId] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid persisted agent occurrence');
  return value;
}

// Advance only as part of the checkpoint that consumes the result. A crash
// before that checkpoint must reattach to the same invocation, not launch twice.
export function consumeAgentOccurrence<T extends InvocationState>(state: T, nodeId: string): T {
  return { ...state, agentInvocationCounts: {
    ...state.agentInvocationCounts, [nodeId]: agentOccurrence(state, nodeId) + 1,
  } };
}
