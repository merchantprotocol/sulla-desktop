// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type AgentRecallUseCaseType = 'skill' | 'agent';
export interface AgentRecallSuggestion { type: AgentRecallUseCaseType; slug: string; title: string; description: string; score: number; reason: string }
export interface AgentRecallQueryOptions { types: AgentRecallUseCaseType[]; allowedSlugs?: string[]; limit?: number; minScore?: number }
export interface AgentRecallSuggestionResponse { items: AgentRecallSuggestion[]; ms: number }
export interface AgentRecallSuggester {
  suggest(text: string, options: AgentRecallQueryOptions): Promise<AgentRecallSuggestion[]>;
}

const MAX_RESULTS = 50;
/** Largest allowlist the index will accept; larger or malformed allowlists are rejected, never truncated. */
export const MAX_ALLOWED_SLUGS = 2000;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_TYPES = new Set<AgentRecallUseCaseType>(['skill', 'agent']);

/** Agent recall's typed IPC boundary; independent from the composer query contract. */
export class AgentUseCaseRecallQuery {
  constructor(private readonly suggester: AgentRecallSuggester, private readonly now: () => number = Date.now) {}

  async query(text: unknown, options?: Partial<AgentRecallQueryOptions>): Promise<AgentRecallSuggestionResponse> {
    const normalizedText = typeof text === 'string' ? text : '';
    if (!normalizedText.trim()) return { items: [], ms: 0 };
    const types = [...new Set((Array.isArray(options?.types) ? options.types : []).filter((type): type is AgentRecallUseCaseType => ALLOWED_TYPES.has(type)))];
    if (types.length === 0) return { items: [], ms: 0 };
    const allowedSlugs = this.normalizeAllowedSlugs(options?.allowedSlugs);
    // A provided but invalid, empty or overlimit allowlist fails closed: no query, no rows.
    if (allowedSlugs === null) return { items: [], ms: 0 };
    const limit = typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(options.limit))) : MAX_RESULTS;
    const started = this.now();
    const minScore = typeof options?.minScore === 'number' && Number.isFinite(options.minScore)
      ? Math.max(0, Math.min(1, options.minScore)) : undefined;
    const rows = await this.suggester.suggest(normalizedText, {
      types, ...(allowedSlugs ? { allowedSlugs } : {}), limit, ...(minScore === undefined ? {} : { minScore }),
    });
    const allow = allowedSlugs ? new Set(allowedSlugs) : undefined;
    return {
      items: rows.filter(row => types.includes(row.type) && (!allow || allow.has(row.slug))).slice(0, limit),
      ms: this.now() - started,
    };
  }

  /** undefined = no slug restriction requested; null = reject the request; otherwise a deduped, non-empty allowlist. */
  private normalizeAllowedSlugs(value: unknown): string[] | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALLOWED_SLUGS) return null;
    const slugs = [...new Set(value)];
    return slugs.every(slug => typeof slug === 'string' && SLUG_PATTERN.test(slug)) ? slugs as string[] : null;
  }
}

type Register = (channel: 'use-case-recall:query', handler: (event: unknown, text: unknown, options?: Partial<AgentRecallQueryOptions>) => Promise<AgentRecallSuggestionResponse>) => void;

export function registerAgentUseCaseRecallQuery(register: Register, suggester: AgentRecallSuggester): AgentUseCaseRecallQuery {
  const query = new AgentUseCaseRecallQuery(suggester);
  register('use-case-recall:query', (_event, text, options) => query.query(text, options));
  return query;
}
