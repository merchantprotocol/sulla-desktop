// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type FileOpenPlacement = 'inline' | 'tab';

/**
 * Invocation data derived from BaseTool state and its trusted chat reporter:
 * threadId is metadata.threadId, executionThreadId is executionContext.thread_id,
 * and hasChatTransport reflects sendChatMessage or wsChannel availability.
 */
export interface TrustedFileOpenContext {
  threadId?: string;
  executionThreadId?: string;
  hasChatTransport: boolean;
  isChatMuted: boolean;
  isSubconsciousSilent: boolean;
}

export type FileOpenRouteDecision =
  | { kind: 'inline'; threadId: string; onFailure: 'propagate' }
  | { kind: 'legacy-tab' };

/**
 * Chooses presentation without consulting the active window or tool arguments
 * for a thread id. Callers must supply only the invocation's trusted context.
 */
export class AgentFileOpenRoutePolicy {
  route(placement: unknown, context: TrustedFileOpenContext): FileOpenRouteDecision {
    if (placement === 'tab') return { kind: 'legacy-tab' };
    if (placement !== undefined && placement !== 'inline') return { kind: 'legacy-tab' };

    const threadId = typeof context.threadId === 'string' ? context.threadId.trim() : '';
    const executionThreadId = typeof context.executionThreadId === 'string' ? context.executionThreadId.trim() : '';
    if (!threadId || !context.hasChatTransport || context.isChatMuted || context.isSubconsciousSilent ||
      (executionThreadId && executionThreadId !== threadId)) {
      return { kind: 'legacy-tab' };
    }

    return { kind: 'inline', threadId, onFailure: 'propagate' };
  }
}
