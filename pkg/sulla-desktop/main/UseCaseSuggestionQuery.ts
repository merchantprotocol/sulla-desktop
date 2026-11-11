// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type SuggestedUseCaseType = 'skill' | 'agent' | 'workflow' | 'recipe';
export interface SuggestedUseCase { type: SuggestedUseCaseType; slug: string; title: string; description: string; score: number; reason: string }
interface IndexedSuggestion extends Omit<SuggestedUseCase, 'type'> { type: SuggestedUseCaseType | 'function' }
export interface UseCaseSuggester {
  suggest(text: string, options: { types: SuggestedUseCaseType[]; limit: number }): Promise<IndexedSuggestion[]>;
}

/** Narrow IPC boundary: callers cannot request or receive function suggestions. */
export class UseCaseSuggestionQuery {
  constructor(private readonly suggester: UseCaseSuggester) {}

  async query(text: unknown, options?: { limit?: unknown }): Promise<{ items: SuggestedUseCase[]; ms: number }> {
    const started = Date.now();
    const query = typeof text === 'string' ? text : '';
    const limit = typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(5, Math.floor(options.limit))) : 5;
    const results = await this.suggester.suggest(query, { types: ['skill', 'agent', 'workflow', 'recipe'], limit });
    return { items: results.filter((item): item is SuggestedUseCase => item.type !== 'function'), ms: Date.now() - started };
  }
}

/** Single registration point; wire the real UseCaseSuggestionIndex here when available. */
export function registerUseCaseSuggestionQuery(
  register: (channel: string, handler: (text: unknown, options?: { limit?: unknown }) => Promise<{ items: SuggestedUseCase[]; ms: number }>) => void,
  suggester: UseCaseSuggester,
): void {
  const query = new UseCaseSuggestionQuery(suggester);
  register('use-case-suggest:query', (text, options) => query.query(text, options));
}
