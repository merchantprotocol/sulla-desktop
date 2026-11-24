// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type FileOpenPlacement = 'inline' | 'tab';

/**
 * Invocation data derived from BaseTool state and its trusted chat reporter.
 * threadId is the trusted state thread id (bound server-side: the graph's own
 * state, or the live graph state behind a verified tool-session token).
 * executionThreadId is executionContext.thread_id, present only for container
 * runtimes; when present it must name the same thread. hasChatTransport
 * reflects sendChatMessage availability. Visibility flags are stamped
 * server-side on the graph state and are never taken from tool arguments.
 */
export interface TrustedFileOpenContext {
  threadId?: string;
  executionThreadId?: string;
  hasChatTransport: boolean;
  isDesktopChatVisible: boolean;
  isSubAgent: boolean;
  isRelayed: boolean;
  isChatMuted: boolean;
  isSubconsciousSilent: boolean;
}

export type FileOpenIneligibleReason =
  | 'no-thread'
  | 'thread-mismatch'
  | 'sub-agent'
  | 'relayed-turn'
  | 'not-visible-desktop-chat'
  | 'chat-muted'
  | 'no-chat-transport';

export type FileOpenRouteDecision =
  | { kind: 'inline'; threadId: string; onFailure: 'propagate' }
  | { kind: 'legacy-tab'; reason: FileOpenIneligibleReason | 'requested-tab' }
  | { kind: 'reject'; reason: 'invalid-placement' | FileOpenIneligibleReason; message: string };

const REASON_TEXT: Record<FileOpenIneligibleReason, string> = {
  'no-thread':                'a call with no chat thread',
  'thread-mismatch':          'an execution identity bound to a different thread',
  'sub-agent':                'a sub-agent',
  'relayed-turn':             'a relayed turn',
  'not-visible-desktop-chat': 'a context that is not a visible Desktop chat turn (mobile relay, API call or hidden job)',
  'chat-muted':               'a muted or background chat run',
  'no-chat-transport':        'a context with no chat transport',
};

/**
 * Chooses presentation without consulting the active window or tool arguments
 * for a thread id. Callers must supply only the invocation's trusted context.
 */
export class AgentFileOpenRoutePolicy {
  route(placement: unknown, context: TrustedFileOpenContext): FileOpenRouteDecision {
    if (placement === 'tab') return { kind: 'legacy-tab', reason: 'requested-tab' };
    if (placement !== undefined && placement !== 'inline') {
      return { kind: 'reject', reason: 'invalid-placement', message: 'Invalid file open placement' };
    }

    const threadId = typeof context.threadId === 'string' ? context.threadId.trim() : '';
    const reason = this.ineligibleReason(threadId, context);
    if (!reason) return { kind: 'inline', threadId, onFailure: 'propagate' };
    if (placement === 'inline') {
      return { kind: 'reject', reason, message: `Inline file cards need a visible Desktop chat; this call came from ${ REASON_TEXT[reason] }. Use placement:"tab" to open the Files tab.` };
    }
    return { kind: 'legacy-tab', reason };
  }

  private ineligibleReason(threadId: string, context: TrustedFileOpenContext): FileOpenIneligibleReason | null {
    if (!threadId) return 'no-thread';
    if (context.executionThreadId && context.executionThreadId !== threadId) return 'thread-mismatch';
    if (context.isSubAgent) return 'sub-agent';
    if (context.isRelayed) return 'relayed-turn';
    if (context.isDesktopChatVisible !== true) return 'not-visible-desktop-chat';
    if (context.isChatMuted || context.isSubconsciousSilent) return 'chat-muted';
    if (context.hasChatTransport !== true) return 'no-chat-transport';
    return null;
  }
}
