// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentRecallQueryOptions, AgentRecallSuggestion } from '../../main/AgentUseCaseRecallQuery';

type QueryOptions = Pick<AgentRecallQueryOptions, 'types' | 'limit' | 'allowedSlugs' | 'minScore'>;

export interface UseCaseSuggestionQuery {
  query(text: string, options: QueryOptions): Promise<AgentRecallSuggestion[]>;
}

export interface SuggestionIpcInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/** Adapter across the agent/main-process boundary; index state stays in main. */
export class IpcUseCaseSuggestionQuery implements UseCaseSuggestionQuery {
  constructor(private readonly ipc: SuggestionIpcInvoker) {}

  async query(text: string, options: QueryOptions): Promise<AgentRecallSuggestion[]> {
    const response = await this.ipc.invoke('use-case-recall:query', text, options);
    if (!response || typeof response !== 'object' || !Array.isArray((response as any).items)) return [];
    return (response as { items: AgentRecallSuggestion[] }).items;
  }
}
