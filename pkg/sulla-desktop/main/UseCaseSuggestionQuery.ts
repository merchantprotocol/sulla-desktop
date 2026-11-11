// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  SUGGESTABLE_USE_CASE_TYPES,
  isSuggestableUseCaseType,
  type SuggestedUseCase,
  type UseCaseSuggestionResponse,
} from '@pkg/shared/useCaseSuggestions';

/** What the index may return; it knows about functions, the composer never shows them. */
export interface IndexedUseCaseSuggestion extends Omit<SuggestedUseCase, 'type'> { type: string }

/** Structural match for UseCaseSuggestionIndex.suggest (agent/useCases). */
export interface UseCaseSuggester {
  suggest(text: string, options: { types?: string[]; limit?: number; minScore?: number }): Promise<IndexedUseCaseSuggestion[]>;
}

export const USE_CASE_SUGGEST_CHANNEL = 'use-case-suggest:query';
const MAX_LIMIT = 5;

/** Narrow IPC boundary: callers cannot request or receive function suggestions. */
export class UseCaseSuggestionQuery {
  constructor(
    private readonly suggester: UseCaseSuggester,
    private readonly now: () => number = Date.now,
  ) {}

  async query(text: unknown, options?: { limit?: unknown }): Promise<UseCaseSuggestionResponse> {
    const started = this.now();
    const query = typeof text === 'string' ? text : '';
    if (!query.trim()) return { items: [], ms: 0 };
    const results = await this.suggester.suggest(query, { types: [...SUGGESTABLE_USE_CASE_TYPES], limit: this.limitFrom(options?.limit) });

    return {
      items: results.filter((item): item is SuggestedUseCase => isSuggestableUseCaseType(item.type)).slice(0, MAX_LIMIT),
      ms:    this.now() - started,
    };
  }

  private limitFrom(limit: unknown): number {
    return typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit))) : MAX_LIMIT;
  }
}

type Register = (channel: typeof USE_CASE_SUGGEST_CHANNEL, handler: (event: unknown, text: unknown, options?: { limit?: unknown }) => Promise<UseCaseSuggestionResponse>) => void;

/**
 * ─── WIRING POINT (S3 → S1) ───────────────────────────────────────────
 * Call once from main/sullaEvents.ts with the real UseCaseSuggestionIndex
 * (agent/useCases) after feat/usecase-suggest-index merges:
 *   registerUseCaseSuggestionQuery((ch, h) => ipcMainProxy.handle(ch, h), index);
 * Until then the channel is unregistered and the composer stays quiet.
 */
export function registerUseCaseSuggestionQuery(register: Register, suggester: UseCaseSuggester): UseCaseSuggestionQuery {
  const query = new UseCaseSuggestionQuery(suggester);
  register(USE_CASE_SUGGEST_CHANNEL, (_event, text, options) => query.query(text, options));

  return query;
}
