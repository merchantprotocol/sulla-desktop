// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ChatMessage } from '../../languagemodels/BaseLanguageModel';
import type { PendingCompletion } from './AgentCompletionInboxService';

interface StallInputInbox {
  currentEntries(channel: string, threadId: string, entries: PendingCompletion[]): Promise<PendingCompletion[]>;
  format(entries: PendingCompletion[]): string;
}

interface StallInput { channel: string; threadId: string; entries: PendingCompletion[] }

/** A process-local wake. Its text exists only in the provider's input snapshot. */
export class DeferredStallInput {
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

  async prepare(threadId: string, messages: ChatMessage[]): Promise<{ prompt: ChatMessage[]; consumed: Set<StallInput> }> {
    const consumed = new Set<StallInput>();
    const resolved = await Promise.all(messages.map(async message => {
      const stall = DeferredStallInput.read(message);
      if (!stall) return message;
      consumed.add(stall);
      if (stall.threadId !== threadId) return undefined;
      const current = await this.inbox.currentEntries(stall.channel, threadId, stall.entries);
      return current.length ? { ...message, content: this.inbox.format(current), metadata: { source: 'sub_agent_completion', inputSource: 'system' } } : undefined;
    }));
    return { prompt: resolved.filter((message): message is ChatMessage => !!message), consumed };
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
