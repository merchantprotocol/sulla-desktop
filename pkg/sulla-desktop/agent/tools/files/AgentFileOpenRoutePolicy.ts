// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type FileOpenPlacement = 'inline' | 'tab';

/**
 * Invocation data derived from BaseTool state and its trusted chat reporter:
 * threadId is the trusted state thread id, executionThreadId is the trusted
 * executionContext.thread_id, and hasChatTransport reflects sendChatMessage or
 * wsChannel availability. Human-visible-chat eligibility is an independent,
 * positive trusted signal; transport availability alone is not visibility.
 */
export interface TrustedFileOpenContext {
  threadId?: string;
  executionThreadId?: string;
  hasChatTransport: boolean;
  isHumanVisibleChatEligible: boolean;
  isChatMuted: boolean;
  isSubconsciousSilent: boolean;
}

export type FileOpenRouteDecision =
  | { kind: 'inline'; threadId: string; onFailure: 'propagate' }
  | { kind: 'legacy-tab' }
  | { kind: 'reject'; reason: 'invalid-placement' };

/**
 * Chooses presentation without consulting the active window or tool arguments
 * for a thread id. Callers must supply only the invocation's trusted context.
 */
export class AgentFileOpenRoutePolicy {
  route(placement: unknown, context: TrustedFileOpenContext): FileOpenRouteDecision {
    if (placement === 'tab') return { kind: 'legacy-tab' };
    if (placement !== undefined && placement !== 'inline') return { kind: 'reject', reason: 'invalid-placement' };

    const trustedThreadId = typeof context.threadId === 'string' ? context.threadId : '';
    const executionThreadId = typeof context.executionThreadId === 'string' ? context.executionThreadId : '';
    const threadId = trustedThreadId.trim();
    if (!threadId || !executionThreadId.trim() || executionThreadId !== trustedThreadId ||
      context.hasChatTransport !== true || context.isHumanVisibleChatEligible !== true ||
      context.isChatMuted || context.isSubconsciousSilent) {
      return { kind: 'legacy-tab' };
    }

    return { kind: 'inline', threadId, onFailure: 'propagate' };
  }
}
