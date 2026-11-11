// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { registerAgentUseCaseRecallQuery, type AgentRecallSuggester } from './AgentUseCaseRecallQuery';
import { registerUseCaseSuggestionQuery, type UseCaseSuggester } from './UseCaseSuggestionQuery';

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
