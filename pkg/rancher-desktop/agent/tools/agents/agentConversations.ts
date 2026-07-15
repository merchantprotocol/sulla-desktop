/**
 * In-memory registry for persistent, multi-turn sub-agent conversations.
 *
 * Unlike spawn_agent (fire-one-prompt-and-run), a conversation keeps the
 * sub-agent's graph + state alive in the GraphRegistry (keyed by threadId) so
 * the parent can send follow-up messages and read replies across many turns —
 * a real back-and-forth with a sub-agent.
 *
 * This module is a PURE registry (no GraphRegistry import): it holds metadata
 * and the transcript. The actual turn execution lives in conversationRunner.ts.
 * Conversations are pruned after a TTL of inactivity; close_agent_conversation
 * frees one eagerly (and drops its GraphRegistry entry).
 */

export interface ConversationTurn {
  from: 'parent' | 'agent';
  text: string;
  ts:   number;
}

export interface AgentConversation {
  conversationId: string;
  threadId:       string;
  channel:        string; // agent-config channel passed to getOrCreateAgentGraph
  label:          string;
  status:         'idle' | 'busy';
  transcript:     ConversationTurn[];
  createdAt:      number;
  lastActive:     number;
}

const CONV_TTL_MS = 60 * 60 * 1000; // 1 hour of inactivity
const MAX_CONVERSATIONS = 20;       // soft cap to prevent runaway spawning

const conversations = new Map<string, AgentConversation>();
let convCounter = 0;

/** True when a new conversation would exceed the soft cap (idle ones aside). */
export function atConversationCap(): boolean {
  pruneStale();

  return conversations.size >= MAX_CONVERSATIONS;
}

export function createConversation(channel: string, label: string): AgentConversation {
  convCounter += 1;
  const stamp = Date.now();
  const slug = label.replace(/\s+/g, '-').toLowerCase();
  const conversationId = `conv-${ stamp }-${ convCounter }`;
  const conv: AgentConversation = {
    conversationId,
    threadId:   `conv-agent-${ slug }-${ stamp }-${ convCounter }`,
    channel,
    label,
    status:     'idle',
    transcript: [],
    createdAt:  stamp,
    lastActive: stamp,
  };

  conversations.set(conversationId, conv);

  return conv;
}

export function getConversation(conversationId: string): AgentConversation | undefined {
  return conversations.get(conversationId);
}

export function getAllConversations(): AgentConversation[] {
  pruneStale();

  return Array.from(conversations.values());
}

export function appendTranscript(conversationId: string, from: 'parent' | 'agent', text: string): void {
  const conv = conversations.get(conversationId);
  if (!conv) return;

  conv.transcript.push({ from, text, ts: Date.now() });
  conv.lastActive = Date.now();
}

export function setStatus(conversationId: string, status: 'idle' | 'busy'): void {
  const conv = conversations.get(conversationId);
  if (!conv) return;

  conv.status = status;
  conv.lastActive = Date.now();
}

export function deleteConversation(conversationId: string): void {
  conversations.delete(conversationId);
}

function pruneStale(): void {
  const now = Date.now();

  for (const [id, conv] of conversations.entries()) {
    // Never prune a conversation mid-turn; only idle-and-stale ones.
    if (conv.status === 'idle' && (now - conv.lastActive) > CONV_TTL_MS) {
      conversations.delete(id);
    }
  }
}
