// Pure run-state transitions. Every mutation of ChatController.runState
// goes through `nextRunState(current, event)`. Invalid transitions return
// the current state unchanged — the controller may choose to log, but
// nothing blows up.
//
// The machine:
//
//   idle ─ send ─▶ thinking ─ spawnTool ─▶ tool ─ toolDone ─▶ streaming
//    ▲                │                                       │
//    │           stop / err                               streamEnd
//    │                ▼                                       │
//    └────────────── paused ◀── hitLimit ─────────────────── ─│
//                                                             ▼
//                                                            idle

import type { RunState } from '../models/RunState';
import type { MessageId } from '../types/chat';

export type RunEvent =
  | { type: 'send';       messageId: MessageId; at?: number }
  | { type: 'think';      messageId: MessageId; at?: number }
  | { type: 'spawnTool';  messageId: MessageId; tool: string; at?: number }
  | { type: 'toolDone';   at?: number }
  | { type: 'stream';     messageId: MessageId; at?: number }
  | { type: 'streamEnd';  at?: number }
  | { type: 'awaitApproval'; messageId: MessageId; at?: number }
  | { type: 'approvalResolved' }
  | { type: 'hitLimit';   at?: number }
  | { type: 'stop';       at?: number }
  | { type: 'error';      message: string; at?: number }
  | { type: 'continue';   at?: number }
  | { type: 'idle';       at?: number };

const now = (e: { at?: number }) => e.at ?? Date.now();

export function nextRunState(current: RunState, e: RunEvent): RunState {
  switch (e.type) {
    case 'send':
    case 'think':
      if (current.phase === 'idle' || current.phase === 'paused' || current.phase === 'error') {
        return { phase: 'thinking', startedAt: now(e), messageId: e.messageId };
      }
      return current;

    case 'spawnTool':
      if (current.phase === 'thinking' || current.phase === 'streaming' || current.phase === 'tool') {
        return { phase: 'tool', startedAt: now(e), messageId: e.messageId, tool: e.tool };
      }
      return current;

    case 'toolDone':
      if (current.phase === 'tool') {
        // Return to thinking; actual downstream event (stream or another spawnTool) will fire next.
        return { phase: 'thinking', startedAt: now(e), messageId: current.messageId };
      }
      return current;

    case 'stream':
      if (current.phase === 'thinking' || current.phase === 'tool' || current.phase === 'idle') {
        return { phase: 'streaming', startedAt: now(e), messageId: e.messageId };
      }
      return current;

    case 'streamEnd':
      if (current.phase === 'streaming') {
        return { phase: 'idle' };
      }
      return current;

    case 'awaitApproval':
      return { phase: 'awaiting_approval', startedAt: now(e), messageId: e.messageId };

    case 'approvalResolved':
      if (current.phase === 'awaiting_approval') {
        return { phase: 'thinking', startedAt: Date.now(), messageId: current.messageId };
      }
      return current;

    case 'hitLimit':
      return { phase: 'paused', reason: 'limit', at: now(e) };

    case 'stop':
      return { phase: 'paused', reason: 'user', at: now(e) };

    case 'error':
      return { phase: 'error', message: e.message, at: now(e) };

    case 'continue':
      if (current.phase === 'paused' && current.reason === 'limit') {
        return { phase: 'thinking', startedAt: now(e), messageId: '' as MessageId };
      }
      return current;

    case 'idle':
      // Force-idle — backend-originated "the graph finished" signal
      // that collapses any active phase back to rest.
      return current.phase === 'idle' ? current : { phase: 'idle' };
  }
}
