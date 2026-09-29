/**
 * Steer channel — delivers "Send now" messages into a run that is already
 * executing, and guarantees none of them are lost.
 *
 * A steer is a user message injected while the graph is mid-run. It lands in
 * state.messages flagged `steerPending`, and stays pending until something
 * actually puts it in front of the model:
 *
 *   - A live CLI turn (Claude Code / Codex) subscribed via onSteer() takes it
 *     immediately — Claude writes it to the running CLI's stdin, Codex
 *     interrupts and resumes its thread with it.
 *   - normalizedChat() marks every pending steer that is part of the prompt
 *     it is about to send (API models read state.messages directly).
 *
 * Anything still pending when a turn finishes was never seen, so AgentNode
 * loops the graph once more instead of ending the run on top of it.
 */
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';

/** Return true when the listener took ownership of delivering the steer. */
export type SteerListener = (message: ChatMessage) => boolean;

const listeners = new WeakMap<object, Set<SteerListener>>();

export function isPendingSteer(message: any): boolean {
  return message?.role === 'user' && message?.metadata?.steerPending === true;
}

export function pendingSteers(state: { messages?: ChatMessage[] }): ChatMessage[] {
  return Array.isArray(state?.messages) ? state.messages.filter(isPendingSteer) : [];
}

export function markSteerDelivered(message: ChatMessage): void {
  const meta = (message as any).metadata;
  if (meta && meta.steerPending) {
    meta.steerPending = false;
    meta.steerDeliveredAt = Date.now();
  }
}

/** Hand a steer back to the graph — the live turn took it but never used it. */
export function markSteerPending(message: ChatMessage): void {
  const meta = (message as any).metadata;
  if (meta) meta.steerPending = true;
}

/**
 * Append a steer to the running state and offer it to the live CLI turn, if
 * one is listening. Stays pending when no listener takes it.
 */
export function injectSteer(state: { messages: ChatMessage[] }, message: ChatMessage): void {
  (message as any).metadata = { ...((message as any).metadata || {}), steerPending: true };
  state.messages.push(message);
  offerSteer(state, message);
}

function offerSteer(state: object, message: ChatMessage): boolean {
  for (const listener of listeners.get(state) ?? []) {
    let taken = false;
    try { taken = listener(message) } catch { /* a broken listener must not drop the steer */ }
    if (taken) {
      markSteerDelivered(message);
      return true;
    }
  }
  return false;
}

/**
 * Subscribe a live turn to steers for this state. Steers already pending (sent
 * after the prompt was built but before the CLI was listening) are offered
 * immediately. Returns the unsubscribe function.
 */
export function onSteer(state: object | undefined | null, listener: SteerListener): () => void {
  if (!state) return () => {};
  let set = listeners.get(state);
  if (!set) {
    set = new Set();
    listeners.set(state, set);
  }
  set.add(listener);
  for (const pending of pendingSteers(state as any)) offerSteer(state, pending);
  return () => { set.delete(listener) };
}

/** Remove and return steers still pending — used when the run already ended. */
export function takePendingSteers(state: { messages: ChatMessage[] }): ChatMessage[] {
  const pending = pendingSteers(state);
  if (pending.length) {
    const rest = state.messages.filter(m => !isPendingSteer(m));
    state.messages.splice(0, state.messages.length, ...rest);
  }
  return pending;
}

/** Plain text of a steer message (text blocks only). */
export function steerText(message: ChatMessage): string {
  const c: any = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
  return '';
}

/**
 * Move steers the model never saw to the end of the transcript (after the
 * reply that raced them) so the next turn treats them as the latest input.
 * Returns how many were pending.
 */
export function requeuePendingSteers(state: { messages: ChatMessage[] }): number {
  const pending = pendingSteers(state);
  if (!pending.length) return 0;
  const rest = state.messages.filter(m => !isPendingSteer(m));
  state.messages.splice(0, state.messages.length, ...rest, ...pending);
  return pending.length;
}
