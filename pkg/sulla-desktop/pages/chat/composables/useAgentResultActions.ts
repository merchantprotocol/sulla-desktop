// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { inject } from 'vue';

import { useChatController } from '../controller/useChatController';

import type { OpenSubAgentConversation } from '../components/subagent/subAgentConversation';

/**
 * What a finished-agent result card can do. None of it acts on the user's
 * behalf: it opens the agent's conversation, opens a link in Sulla's
 * browser, copies text, or drafts a message into this chat's composer.
 */
function useAgentResultActions() {
  const openConversation = inject<OpenSubAgentConversation | undefined>('chat:open-subagent-conversation', undefined);
  let threadId: string | undefined;
  try { threadId = useChatController().thread.value.id } catch { /* outside a chat page */ }

  return {
    /** False when there is no conversation to open. */
    openAgent(target: { agentId?: string; label: string; threadId?: string }): boolean {
      if (!openConversation || !target.threadId) return false;
      openConversation({ agentId: target.agentId || 'agent', label: target.label, conversationId: target.threadId });
      return true;
    },
    /** Puts text in this chat's message box for the user to edit and send. */
    draft(text: string): void {
      window.dispatchEvent(new CustomEvent('chat:draft', { detail: { threadId, text } }));
    },
    async copy(text: string): Promise<boolean> {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    /** Opens in Sulla's own browser tab, the app's default for links. */
    openUrl(url: string): void {
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    },
  };
}

/** The actions a result card offers (retry, resolve with Sulla, jump to). */
export class AgentResultActions {
  static readonly useAgentResultActions = useAgentResultActions;
}
