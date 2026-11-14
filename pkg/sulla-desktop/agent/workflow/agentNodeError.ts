// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

// A turn that died posts "Agent error: …" after its graph has already
// unwound. Treating that bubble as activity left the chat "running" forever,
// which also paused the chat heartbeat that should wake it back up.
export function isTerminalRunError(msg: { type?: string; data?: unknown }): boolean {
  if (msg.type !== 'assistant_message') return false;
  const data = msg.data as any;
  const content = typeof data === 'string' ? data : data?.content;
  if (data && typeof data === 'object' && data.runEnded === true) return true;
  return typeof content === 'string' && content.trimStart().startsWith('Agent error:');
}
