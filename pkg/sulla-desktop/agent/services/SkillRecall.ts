// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { UseCaseSuggestionQuery } from './UseCaseSuggestionQueryClient';

export const SKILL_FIT_MAX = 4;
export const SKILL_DESCRIPTION_MAX_CHARS = 240;

function shortDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  return flat.length > SKILL_DESCRIPTION_MAX_CHARS ? `${ flat.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 1) }…` : flat;
}

/** Produces the existing installed_skills block from main-process vector suggestions. */
export class SkillRecallService {
  constructor(private readonly suggestions: UseCaseSuggestionQuery) {}

  async buildContext(text: string): Promise<string> {
    if (!text.trim()) return '';
    // risk: published-only content — the main-process index is the authority and never returns drafts.
    const fits = await this.suggestions.query(text, { types: ['skill'], limit: SKILL_FIT_MAX });
    if (fits.length === 0) return '';
    return [
      'Installed skills that may fit this turn (semantic suggestion, not an order; you decide). Load one in full with `sulla skills/skill_get \'{"slug":"<slug>"}\'` before you use it.',
      ...fits.map(skill => `- [skill:${ skill.slug }] ${ skill.title }: ${ shortDescription(skill.description) }`),
    ].join('\n');
  }
}
