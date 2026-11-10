// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Ranks tools for a browse_tools query. Ported from #2053 (rank exact browse
 * tool matches) onto current main, with exact-name matching widened to the
 * manifest name, CLI path, and CLI endpoint in any spacing/underscore form.
 *
 * Stateless: safe to construct once and share.
 */

export interface ToolSearchCandidate {
  name: string;
  description: string;
  category: string;
}

const SCORE_EXACT = 3;
const SCORE_ALL_TOKENS = 2;
const SCORE_ANY_TOKEN = 1;

export class ToolSearchRanker {
  /** Highest-scoring candidates first; ties keep registry order. */
  rank<T extends ToolSearchCandidate>(candidates: T[], query: string, limit = 50): T[] {
    const normalizedQuery = this.normalize(query);
    if (!normalizedQuery) return [];
    const tokens = normalizedQuery.split(' ');

    return candidates
      .map((candidate, index) => ({ candidate, index, score: this.score(candidate, normalizedQuery, tokens) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit)
      .map(item => item.candidate);
  }

  private score(candidate: ToolSearchCandidate, normalizedQuery: string, tokens: string[]): number {
    if (this.exactForms(candidate).includes(normalizedQuery)) return SCORE_EXACT;

    const searchable = this.normalize(`${ candidate.name } ${ candidate.description }`);
    if (tokens.every(token => searchable.includes(token))) return SCORE_ALL_TOKENS;
    if (tokens.some(token => searchable.includes(token))) return SCORE_ANY_TOKEN;
    return 0;
  }

  /** Name forms a user might type exactly: manifest name, CLI endpoint, and CLI path. */
  private exactForms(candidate: ToolSearchCandidate): string[] {
    const name = this.normalize(candidate.name);
    const category = this.normalize(candidate.category);
    const endpoint = name.startsWith(`${ category } `) ? name.slice(category.length + 1) : name;
    return [name, endpoint, `${ category } ${ endpoint }`];
  }

  /** Lowercases and collapses every run of non-alphanumerics (space, _, /, -) to one space. */
  private normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
}
