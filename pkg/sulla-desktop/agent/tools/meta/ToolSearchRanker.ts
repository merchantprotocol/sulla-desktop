// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ToolSearchCandidate {
  name: string;
  description: string;
  category: string;
}

export class ToolSearchRanker {
  private normalize(value: string): string {
    return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
  }

  private tokens(value: string): string[] {
    return this.normalize(value).split(' ').filter(Boolean);
  }

  private rank(candidate: ToolSearchCandidate, query: string): number {
    const normalizedQuery = this.normalize(query);
    const normalizedName = this.normalize(candidate.name);
    const endpoint = normalizedName.replace(`${ this.normalize(candidate.category) } `, '').trim();
    const qualifiedName = `${ this.normalize(candidate.category) } ${ endpoint }`;
    if (normalizedQuery === normalizedName || normalizedQuery === endpoint || normalizedQuery === qualifiedName) return 3;

    const queryTokens = this.tokens(query);
    const searchable = `${ normalizedName } ${ this.normalize(candidate.description) }`;
    if (queryTokens.length > 0 && queryTokens.every(token => searchable.includes(token))) return 2;
    if (queryTokens.some(token => searchable.includes(token))) return 1;
    return 0;
  }

  public rank(candidates: ToolSearchCandidate[], query: string, limit = 50): ToolSearchCandidate[] {
    return candidates
      .map((candidate, index) => ({ candidate, index, score: this.rank(candidate, query) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit)
      .map(item => item.candidate);
  }
}
