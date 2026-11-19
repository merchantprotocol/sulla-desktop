// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { TitleMessage } from './ConversationTitleService';

/** Keeps only the title-eligible prefix, never an unbounded transcript. */
export class TitleMessageBuffer {
  private readonly conversations = new Map<string, TitleMessage[]>();
  constructor(private readonly maxMessages = 5, private readonly maxConversations = 500) {}
  append(conversationId: string, message: TitleMessage): TitleMessage[] {
    let messages = this.conversations.get(conversationId);
    if (!messages) {
      messages = [];
      this.conversations.set(conversationId, messages);
    }
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, messages);
    if (messages.length < this.maxMessages) messages.push(message);
    while (this.conversations.size > this.maxConversations) {
      this.conversations.delete(this.conversations.keys().next().value!);
    }
    return messages;
  }
  delete(conversationId: string): void { this.conversations.delete(conversationId); }
  get size(): number { return this.conversations.size; }
}
