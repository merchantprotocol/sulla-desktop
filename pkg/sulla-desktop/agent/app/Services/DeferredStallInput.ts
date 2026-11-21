// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ChatMessage } from '../../languagemodels/BaseLanguageModel';
import type { PendingCompletion } from './AgentCompletionInboxService';

interface StallInputInbox {
  currentEntries(channel: string, threadId: string, entries: PendingCompletion[]): Promise<PendingCompletion[]>;
  format(entries: PendingCompletion[]): string;
}

type InputState = { messages: ChatMessage[] };

interface StallInput { channel: string; threadId: string; entries: PendingCompletion[] }

/** A process-local wake. Its text exists only in the provider's input snapshot. */
export class DeferredStallInput {
  private static readonly actionable = new WeakMap<InputState, WeakSet<object>>();
  private static readonly staleOnly = new WeakSet<InputState>();

  /** Record at ingress, not from the role at the end of a persisted transcript. */
  static markActionable(state: InputState, message: ChatMessage): void {
    if (this.read(message)) return;
    message.metadata ??= {};
    let marked = this.actionable.get(state);
    if (!marked) this.actionable.set(state, marked = new WeakSet());
    marked.add(message.metadata);
  }

  static appendActionable(state: InputState, message: ChatMessage): void {
    this.markActionable(state, message);
    state.messages.push(message);
  }

  static actionableMessages(state: InputState, messages = state.messages): ChatMessage[] {
    const marked = this.actionable.get(state);
    return messages.filter(message => !this.read(message) && !!message.metadata
      && marked?.has(message.metadata));
  }

  static settledInputs(state: InputState, messages: ChatMessage[]): void {
    const marked = this.actionable.get(state);
    for (const message of messages) if (message.metadata) marked?.delete(message.metadata);
  }

  static isStaleOnly(state: InputState): boolean { return this.staleOnly.has(state) }
  static setStaleOnly(state: InputState, stale: boolean): void {
    if (stale) this.staleOnly.add(state);
    else this.staleOnly.delete(state);
  }

  static beginDispatch(state: InputState): void {
    this.actionable.delete(state);
    this.staleOnly.delete(state);
  }

  constructor(private readonly inbox: StallInputInbox) {}

  static metadata(channel: string, threadId: string, entries: PendingCompletion[]): ChatMessage['metadata'] {
    return { source: 'sub_agent_completion', inputSource: 'system', deferredStall: { channel, threadId, entries } };
  }

  static read(message: ChatMessage | undefined): StallInput | undefined {
    return message?.metadata?.deferredStall as StallInput | undefined;
  }

  static persistentMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter(message => !this.read(message));
  }

  async prepare(threadId: string, messages: ChatMessage[]): Promise<{ prompt: ChatMessage[]; consumed: Set<StallInput>; hasCurrentStall: boolean }> {
    const consumed = new Set<StallInput>();
    let hasCurrentStall = false;
    const resolved = await Promise.all(messages.map(async message => {
      const stall = DeferredStallInput.read(message);
      if (!stall) return message;
      consumed.add(stall);
      if (stall.threadId !== threadId) return undefined;
      const current = await this.inbox.currentEntries(stall.channel, threadId, stall.entries);
      if (current.length) hasCurrentStall = true;
      return current.length ? { ...message, content: this.inbox.format(current), metadata: { source: 'sub_agent_completion', inputSource: 'system' } } : undefined;
    }));
    return { prompt: resolved.filter((message): message is ChatMessage => !!message), consumed, hasCurrentStall };
  }

  static consume(state: { messages: ChatMessage[] }, consumed: ReadonlySet<StallInput>): void {
    // Only remove placeholders that were in this snapshot. A steer that arrived
    // during lookup stays pending for the next model iteration.
    state.messages = state.messages.filter(message => {
      const stall = this.read(message);
      return !stall || !consumed.has(stall);
    });
  }
}
