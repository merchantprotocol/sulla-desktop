/**
 * Detection of agent-node hard failures surfaced as chat output.
 *
 * When AgentNode's execution throws (LLM provider 402/401, timeout, etc.) it
 * pushes the error to the conversation as an assistant message tagged
 * `metadata.kind === 'agent_error'` and returns that message string as the
 * node result. The workflow engine must treat that as a failed node — not as
 * successful node output — otherwise the execution is recorded as
 * `completed, error=''` and routine_run_history / the routine digest stay
 * green through a total provider outage.
 */

export const AGENT_ERROR_MESSAGE_PREFIX = '⚠️ I encountered an error and couldn\'t complete the request';

interface AssistantMessageLike {
  metadata?: { kind?: string } & Record<string, unknown>;
}

/**
 * Returns the failure reason if the assistant message is an agent-error
 * surface, or null if it is genuine output.
 *
 * Primary signal is the structured `kind: 'agent_error'` metadata stamped by
 * AgentNode's catch block; the message-prefix match is a fallback for
 * messages that lost their metadata (e.g. round-tripped through persistence).
 */
export function detectAgentNodeError(
  lastAssistant: AssistantMessageLike | undefined,
  resultText: string,
): string | null {
  if (lastAssistant?.metadata?.kind === 'agent_error') {
    return resultText.trim() || 'Agent node reported an unrecoverable error';
  }
  if (resultText.trimStart().startsWith(AGENT_ERROR_MESSAGE_PREFIX)) {
    return resultText.trim();
  }

  return null;
}
