// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * @deprecated Compatibility facade. The registry lives in
 * app/Services/AgentConversationRegistry, bound by AgentConversationServiceProvider.
 */

import { agentConversationProvider } from '../../app/Providers/AgentConversationServiceProvider';

export type { AgentConversation, ConversationTurn } from '../../app/Services/AgentConversationRegistry';
import type { AgentConversation } from '../../app/Services/AgentConversationRegistry';

const registry = () => agentConversationProvider.conversations;

/** @deprecated Use agentConversationProvider.conversations.atCap(). */
export function atConversationCap(): boolean {
  return registry().atCap();
}

/** @deprecated Use agentConversationProvider.conversations.create(). */
export function createConversation(channel: string, label: string): AgentConversation {
  return registry().create(channel, label);
}

/** @deprecated Use agentConversationProvider.conversations.get(). */
export function getConversation(conversationId: string): AgentConversation | undefined {
  return registry().get(conversationId);
}

/** @deprecated Use agentConversationProvider.conversations.all(). */
export function getAllConversations(): AgentConversation[] {
  return registry().all();
}

/** @deprecated Use agentConversationProvider.conversations.appendTranscript(). */
export function appendTranscript(conversationId: string, from: 'parent' | 'agent', text: string): void {
  registry().appendTranscript(conversationId, from, text);
}

/** @deprecated Use agentConversationProvider.conversations.setStatus(). */
export function setStatus(conversationId: string, status: 'idle' | 'busy'): void {
  registry().setStatus(conversationId, status);
}

/** @deprecated Use agentConversationProvider.conversations.delete(). */
export function deleteConversation(conversationId: string): void {
  registry().delete(conversationId);
}
