// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { registerAgentUseCaseRecallQuery, type AgentRecallSuggester } from './AgentUseCaseRecallQuery';
import { registerUseCaseSuggestionQuery, type UseCaseSuggester } from './UseCaseSuggestionQuery';
import { SUGGESTABLE_USE_CASE_TYPES } from '@pkg/shared/useCaseSuggestions';
import type { SuggestionOptions, UseCaseSuggestion } from '@pkg/agent/useCases/UseCaseSuggestionIndex';

export interface UseCaseSuggestionWatcher {
  queryUseCaseSuggestions(text: string, options?: SuggestionOptions): Promise<UseCaseSuggestion[]>;
}

/** The two channels deliberately share one watcher-owned ranking service. */
export class UseCaseSuggestionIpcRegistrar {
  constructor(
    private readonly registerSuggestion: Parameters<typeof registerUseCaseSuggestionQuery>[0],
    private readonly registerRecall: Parameters<typeof registerAgentUseCaseRecallQuery>[0],
    private readonly suggestionSuggester: UseCaseSuggester,
    private readonly recallSuggester: AgentRecallSuggester,
  ) {}

  register(): void {
    registerUseCaseSuggestionQuery(this.registerSuggestion, this.suggestionSuggester);
    registerAgentUseCaseRecallQuery(this.registerRecall, this.recallSuggester);
  }
}

/** Build both IPC adapters from the watcher-owned index without crossing their distinct response types. */
export function createUseCaseSuggestionIpcRegistrar(
  registerSuggestion: Parameters<typeof registerUseCaseSuggestionQuery>[0],
  registerRecall: Parameters<typeof registerAgentUseCaseRecallQuery>[0],
  watcher: UseCaseSuggestionWatcher,
): UseCaseSuggestionIpcRegistrar {
  const suggestionSuggester: UseCaseSuggester = {
    suggest: (text, options) => watcher.queryUseCaseSuggestions(text, {
      types: [...SUGGESTABLE_USE_CASE_TYPES],
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }),
  };
  const recallSuggester: AgentRecallSuggester = {
    suggest: async(text, options) => {
      const rows = await watcher.queryUseCaseSuggestions(text, options);
      return rows.flatMap((row) => row.type === 'skill' || row.type === 'agent'
        ? [{ type: row.type, slug: row.slug, title: row.title, description: row.description, score: row.score, reason: row.reason }]
        : []);
    },
  };
  return new UseCaseSuggestionIpcRegistrar(registerSuggestion, registerRecall, suggestionSuggester, recallSuggester);
}
