// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as crypto from 'crypto';

const DEFAULT_MAX_CONVERSATIONS = 128;
const CONTENT_HASHED_SECTIONS = new Set(['conversation_context', 'subagent_directory']);
const ITEM_ID = /(?:\[id:[^\]]+\]|\[skill:[^\]]+\]|\[[A-Za-z0-9_-]{4,}\])/;
const SECTION = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;

interface ConversationRecallState {
  sessionId: string;
  itemIdsBySection: Map<string, Set<string>>;
  sectionHashes: Map<string, string>;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Removes recall payload already persisted in a resumed provider session.
 * State is deliberately process-local: losing it only causes one harmless
 * full recall resend, while persisting it could incorrectly suppress context
 * after a provider compact/reset that kept the same conversation id.
 */
export class RecallDedupe {
  private readonly conversations = new Map<string, ConversationRecallState>();

  constructor(private readonly maxConversations = DEFAULT_MAX_CONVERSATIONS) {}

  reset(conversationId?: string): void {
    if (conversationId === undefined) this.conversations.clear();
    else this.conversations.delete(conversationId);
  }

  dedupe(conversationId: string, sessionId: string, syntheticContext: string): string {
    const state = this.stateFor(conversationId, sessionId);

    return syntheticContext.replace(SECTION, (whole, tag: string, body: string) => {
      const sectionBody = body.trim();
      if (!sectionBody) return '';

      // These two sections are dynamic snapshots rather than recall lists.
      // Re-send them only when their complete content changes.
      if (CONTENT_HASHED_SECTIONS.has(tag)) {
        return this.keepChangedSection(state, tag, whole, sectionBody);
      }

      const lines = sectionBody.split('\n');
      const starts: Array<{ index: number; id: string }> = [];
      lines.forEach((line, index) => {
        const match = line.match(ITEM_ID);
        if (match) starts.push({ index, id: match[0] });
      });

      // Narrative/non-list sections are compared as a complete snapshot.
      if (!starts.length) return this.keepChangedSection(state, tag, whole, sectionBody);

      const seen = state.itemIdsBySection.get(tag) ?? new Set<string>();
      state.itemIdsBySection.set(tag, seen);
      const kept: string[] = [];

      // Preserve section preamble only when at least one new item survives.
      const preamble = lines.slice(0, starts[0].index);
      for (let i = 0; i < starts.length; i++) {
        const item = starts[i];
        const end = starts[i + 1]?.index ?? lines.length;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        kept.push(lines.slice(item.index, end).join('\n'));
      }

      if (!kept.length) return '';
      const content = [...preamble, ...kept].join('\n').trim();
      return `<${ tag }>\n${ content }\n</${ tag }>`;
    }).replace(/\n{3,}/g, '\n\n').trim();
  }

  private stateFor(conversationId: string, sessionId: string): ConversationRecallState {
    const current = this.conversations.get(conversationId);
    if (current?.sessionId === sessionId) {
      // Map insertion order doubles as a tiny LRU.
      this.conversations.delete(conversationId);
      this.conversations.set(conversationId, current);
      return current;
    }

    const next: ConversationRecallState = {
      sessionId,
      itemIdsBySection: new Map(),
      sectionHashes: new Map(),
    };
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, next);
    while (this.conversations.size > this.maxConversations) {
      const oldest = this.conversations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.conversations.delete(oldest);
    }
    return next;
  }

  private keepChangedSection(
    state: ConversationRecallState,
    tag: string,
    whole: string,
    sectionBody: string,
  ): string {
    const nextHash = hash(sectionBody);
    if (state.sectionHashes.get(tag) === nextHash) return '';
    state.sectionHashes.set(tag, nextHash);
    return whole;
  }
}
