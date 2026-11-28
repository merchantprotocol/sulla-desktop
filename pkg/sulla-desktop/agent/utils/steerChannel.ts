// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
import { DeferredStallInput } from '../app/Services/DeferredStallInput';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { ParentInputWaitRecorder, type ParentInputWaitBoundary, type ParentInputWaitRecord } from '../services/ParentInputWaitRecorder';

/** Return true when the listener took ownership of delivering the steer. */
export type SteerListener = (message: ChatMessage) => boolean;

const listeners = new WeakMap<object, Set<SteerListener>>();
const STEER_CONSUMED_CALLBACK = Symbol('steer-consumed-callback');
const PARENT_INPUT_WAIT_RECORDER = Symbol('parent-input-wait-recorder');
const STEER_CONSUMED_PROMISE = Symbol('steer-consumed-promise');

export interface SteerInjectionOptions {
  /** Runtime-only callback; it is deliberately non-enumerable and never persisted with thread state. */
  onConsumed?: (message: ChatMessage, boundary: ParentInputWaitBoundary) => Promise<void> | void;
  /** Injected with the steer so the same recorder owns both defer and delivery events. */
  recorder?: ParentInputWaitRecorder;
}

export function isPendingSteer(message: any): boolean {
  return message?.role === 'user' && message?.metadata?.steerPending === true;
}

export function pendingSteers(state: { messages?: ChatMessage[] }): ChatMessage[] {
  return Array.isArray(state?.messages) ? state.messages.filter(isPendingSteer) : [];
}

export function markSteerDelivered(message: ChatMessage, boundary: ParentInputWaitBoundary = 'api_prompt'): void {
  const meta = (message as any).metadata;
  if (meta && meta.steerPending) {
    meta.steerPending = false;
    meta.steerDeliveredAt = Date.now();
    const deliveredBoundary = meta.parentInputWaitBoundary === 'followup' ? 'followup' : boundary;
    const waits = Array.isArray(meta.parentInputWait) ? meta.parentInputWait as ParentInputWaitRecord[] : [];
    if (waits.length) {
      const recorder = ((message as any)[PARENT_INPUT_WAIT_RECORDER] as ParentInputWaitRecorder | undefined) ?? new ParentInputWaitRecorder();
      for (const wait of waits) recorder.delivered(wait, deliveredBoundary, meta.steerDeliveredAt);
      const onConsumed = (message as any)[STEER_CONSUMED_CALLBACK] as SteerInjectionOptions['onConsumed'] | undefined;
      delete (message as any)[STEER_CONSUMED_CALLBACK];
      delete (message as any)[PARENT_INPUT_WAIT_RECORDER];
      if (onConsumed) {
        const settled = Promise.resolve().then(() => onConsumed(message, deliveredBoundary)).catch(error => {
          console.warn('[steerChannel] parent input acknowledgement failed:', error?.name ?? 'unknown');
        });
        Object.defineProperty(message, STEER_CONSUMED_PROMISE, { value: settled, configurable: true });
      }
    }
    if (!waits.length && typeof meta.jobMessageId === 'string' && typeof meta.jobMessageThreadId === 'string') {
      void import('../database/models/AgentJobMessagingModel')
        .then(({ AgentJobMessagingModel }) => AgentJobMessagingModel.markMessagesDelivered(
          [meta.jobMessageId],
          meta.jobMessageThreadId,
        ))
        .catch(err => console.warn('[steerChannel] could not mark job message delivered:', (err as Error).message));
    }
  }
}

/** Wait for boundary acknowledgements before the run-end drain can replay a durable input. */
export async function awaitSteerAcknowledgements(state: { messages?: ChatMessage[] }): Promise<void> {
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  const pending = messages.map(message => (message as any)[STEER_CONSUMED_PROMISE]).filter((value): value is Promise<void> => Boolean(value));
  if (pending.length) await Promise.all(pending);
  for (const message of messages) delete (message as any)[STEER_CONSUMED_PROMISE];
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
export function injectSteer(state: {
  messages: ChatMessage[];
  metadata?: { reportingDecisionFollowUp?: { id: string; threadId: string }; reportingSteerRevision?: number };
}, message: ChatMessage, options: SteerInjectionOptions = {}): boolean {
  if (state.metadata) {
    delete state.metadata.reportingDecisionFollowUp;
    state.metadata.reportingSteerRevision = (state.metadata.reportingSteerRevision ?? 0) + 1;
  }
  if (options.onConsumed) Object.defineProperty(message, STEER_CONSUMED_CALLBACK, { value: options.onConsumed, configurable: true });
  if (options.recorder) Object.defineProperty(message, PARENT_INPUT_WAIT_RECORDER, { value: options.recorder, configurable: true });
  (message as any).metadata = { ...((message as any).metadata || {}), steerPending: true };
  DeferredStallInput.appendActionable(state, message);
  return offerSteer(state, message);
}

function offerSteer(state: object, message: ChatMessage): boolean {
  // A synchronous CLI steer cannot validate a process-local stall episode.
  if (DeferredStallInput.read(message)) return false;
  for (const listener of listeners.get(state) ?? []) {
    let taken = false;
    try { taken = listener(message) } catch { /* a broken listener must not drop the steer */ }
    if (taken) {
      // Parent-input waits stay pending until the provider confirms the actual
      // snapshot/replay/resume boundary, not merely a successful stdin write.
      if (!Array.isArray((message as any).metadata?.parentInputWait)) markSteerDelivered(message);
      DeferredStallInput.settledInputs(state as { messages: ChatMessage[] }, [message]);
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
