// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type AgentRecallUseCaseType = 'skill' | 'agent';
export interface AgentRecallSuggestion { type: AgentRecallUseCaseType; slug: string; title: string; description: string; score: number; reason: string }
export interface AgentRecallQueryOptions { types: AgentRecallUseCaseType[]; allowedSlugs?: string[]; limit?: number }
export interface AgentRecallSuggestionResponse { items: AgentRecallSuggestion[]; ms: number }
export interface AgentRecallSuggester {
  suggest(text: string, options: AgentRecallQueryOptions): Promise<AgentRecallSuggestion[]>;
}

const MAX_RESULTS = 50;
const ALLOWED_TYPES = new Set<AgentRecallUseCaseType>(['skill', 'agent']);

/** Agent recall's typed IPC boundary; independent from the composer query contract. */
export class AgentUseCaseRecallQuery {
  constructor(private readonly suggester: AgentRecallSuggester, private readonly now: () => number = Date.now) {}

  async query(text: unknown, options?: Partial<AgentRecallQueryOptions>): Promise<AgentRecallSuggestionResponse> {
    const normalizedText = typeof text === 'string' ? text : '';
    if (!normalizedText.trim()) return { items: [], ms: 0 };
    const types = [...new Set((Array.isArray(options?.types) ? options.types : []).filter((type): type is AgentRecallUseCaseType => ALLOWED_TYPES.has(type)))];
    if (types.length === 0) return { items: [], ms: 0 };
    const allowedSlugs = Array.isArray(options?.allowedSlugs)
      ? [...new Set(options.allowedSlugs.filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0))].slice(0, MAX_RESULTS)
      : undefined;
    const limit = typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(options.limit))) : MAX_RESULTS;
    const started = this.now();
    const rows = await this.suggester.suggest(normalizedText, { types, ...(allowedSlugs ? { allowedSlugs } : {}), limit });
    const allow = allowedSlugs ? new Set(allowedSlugs) : undefined;
    return {
      items: rows.filter(row => types.includes(row.type) && (!allow || allow.has(row.slug))).slice(0, limit),
      ms: this.now() - started,
    };
  }
}

type Register = (channel: 'use-case-recall:query', handler: (event: unknown, text: unknown, options?: Partial<AgentRecallQueryOptions>) => Promise<AgentRecallSuggestionResponse>) => void;

export function registerAgentUseCaseRecallQuery(register: Register, suggester: AgentRecallSuggester): AgentUseCaseRecallQuery {
  const query = new AgentUseCaseRecallQuery(suggester);
  register('use-case-recall:query', (_event, text, options) => query.query(text, options));
  return query;
}
