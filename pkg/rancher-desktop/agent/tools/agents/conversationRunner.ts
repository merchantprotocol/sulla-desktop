/**
 * Executes one turn of a persistent sub-agent conversation.
 *
 * Resolves the (cached, resumable) graph + state for the conversation's
 * threadId from the GraphRegistry, appends the parent's message, runs one
 * agent turn, and records both sides in the transcript. Reused by
 * start_agent_conversation (first turn) and send_agent_message (follow-ups).
 */

import { appendTranscript, setStatus } from './agentConversations';
import { extractAgentTurnOutcome } from './agentTurnOutcome';

import type { AgentConversation } from './agentConversations';
import type { AbortService } from '../../services/AbortService';

export interface TurnResult {
  status: 'completed' | 'blocked' | 'error';
  reply:  string;
}

export async function runConversationTurn(
  conv: AgentConversation,
  userMessage: string,
  parentState: any,
  isFirstTurn: boolean,
): Promise<TurnResult> {
  const { GraphRegistry } = await import('../../services/GraphRegistry');

  // Same threadId → same cached {graph, state}, so history carries across turns.
  const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(
    conv.channel,
    conv.threadId,
  );

  // Follow-up turns: clear the previous turn's completion flags so the agent
  // loop runs again instead of exiting immediately on stale cycleComplete.
  // (execute() only self-resets these under the playbook-reentry path.)
  if (!isFirstTurn) {
    subState.metadata.cycleComplete = false;
    subState.metadata.waitingForUser = false;
    subState.metadata.agentLoopCount = 0;
    if (subState.metadata.agent) subState.metadata.agent.status = undefined;
  }

  subState.messages.push({ role: 'user', content: userMessage });

  // Mark sub-agent lineage + parent channel (so the sub-agent can message the
  // parent back via <channel:...> if it chooses).
  subState.metadata.isSubAgent = true;
  subState.metadata.subAgentDepth = (parentState?.metadata?.subAgentDepth ?? 0) + 1;
  subState.metadata.workflowParentChannel = parentState?.metadata?.wsChannel || 'sulla-desktop';

  // Propagate the parent's abort service so a user stop reaches the sub-agent.
  const parentAbort: AbortService | undefined = parentState?.metadata?.options?.abort;
  if (parentAbort) {
    subState.metadata.options ??= {};
    subState.metadata.options.abort = parentAbort;
  }

  appendTranscript(conv.conversationId, 'parent', userMessage);
  setStatus(conv.conversationId, 'busy');

  try {
    const finalState = await graph.execute(subState);

    const { status, text: reply } = extractAgentTurnOutcome(finalState);
    appendTranscript(conv.conversationId, 'agent', reply);

    return { status, reply };
  } catch (err) {
    const reply = `Error: ${ (err as Error).message }`;
    appendTranscript(conv.conversationId, 'agent', reply);

    return { status: 'error', reply };
  } finally {
    setStatus(conv.conversationId, 'idle');
  }
}
