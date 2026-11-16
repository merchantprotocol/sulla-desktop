// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { threadSlug } from '../../tools/agents/threadSlug';

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

/**
 * In-memory registry for persistent, multi-turn sub-agent conversations.
 *
 * It remains only for read/close compatibility with conversations opened
 * before the spawn_agent migration. Idle conversations expire after the TTL;
 * a conversation mid-turn is never pruned.
 */
export class AgentConversationRegistry {
  static readonly TTL_MS = 60 * 60 * 1000; // 1 hour of inactivity
  static readonly MAX_CONVERSATIONS = 20;  // soft cap to prevent runaway spawning

  private readonly conversations = new Map<string, AgentConversation>();
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** True when a new conversation would exceed the soft cap (idle ones aside). */
  atCap(): boolean {
    this.pruneStale();

    return this.conversations.size >= AgentConversationRegistry.MAX_CONVERSATIONS;
  }

  create(channel: string, label: string): AgentConversation {
    this.counter += 1;
    const stamp = this.now();
    const slug = threadSlug(label);
    const conversationId = `conv-${ stamp }-${ this.counter }`;
    const conv: AgentConversation = {
      conversationId,
      threadId:   `conv-agent-${ slug }-${ stamp }-${ this.counter }`,
      channel,
      label,
      status:     'idle',
      transcript: [],
      createdAt:  stamp,
      lastActive: stamp,
    };

    this.conversations.set(conversationId, conv);

    return conv;
  }

  get(conversationId: string): AgentConversation | undefined {
    return this.conversations.get(conversationId);
  }

  all(): AgentConversation[] {
    this.pruneStale();

    return Array.from(this.conversations.values());
  }

  appendTranscript(conversationId: string, from: 'parent' | 'agent', text: string): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) return;

    conv.transcript.push({ from, text, ts: this.now() });
    conv.lastActive = this.now();
  }

  setStatus(conversationId: string, status: 'idle' | 'busy'): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) return;

    conv.status = status;
    conv.lastActive = this.now();
  }

  delete(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  private pruneStale(): void {
    const now = this.now();

    for (const [id, conv] of this.conversations.entries()) {
      // Never prune a conversation mid-turn; only idle-and-stale ones.
      if (conv.status === 'idle' && (now - conv.lastActive) > AgentConversationRegistry.TTL_MS) {
        this.conversations.delete(id);
      }
    }
  }
}
