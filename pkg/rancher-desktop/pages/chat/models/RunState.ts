// Discriminated union for the chat's current run phase.
// Transitions are governed by the pure function in
// controller/runStateMachine.ts — no other code may mutate this.

import type { MessageId } from '../types/chat';

export type RunState =
  | { phase: 'idle' }
  | { phase: 'thinking'; startedAt: number; messageId: MessageId }
  | { phase: 'tool';     startedAt: number; messageId: MessageId; tool: string }
  | { phase: 'streaming'; startedAt: number; messageId: MessageId }
  | { phase: 'awaiting_approval'; startedAt: number; messageId: MessageId }
  | { phase: 'paused'; reason: 'limit' | 'user' | 'error'; at: number }
  | { phase: 'error'; message: string; at: number };

export const isRunning = (r: RunState): boolean =>
  r.phase === 'thinking' || r.phase === 'tool' || r.phase === 'streaming';

export const canContinue = (r: RunState): boolean =>
  r.phase === 'paused' && r.reason === 'limit';

export const idle = (): RunState => ({ phase: 'idle' });
