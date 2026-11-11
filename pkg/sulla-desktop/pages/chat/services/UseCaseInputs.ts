// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DeclaredUseCaseInput } from '@pkg/shared/useCaseSuggestions';

/**
 * Deterministic, intentionally conservative prefill for declared inputs.
 * It only fills a field when the draft contains an unambiguous match for the
 * field's kind (email, "last N days", a date, or a quoted name). Anything else
 * stays empty so the user — or the agent — supplies it.
 */
export class UseCaseInputExtractor {
  private static readonly EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/;
  private static readonly LAST_N_DAYS = /\b(?:last|past)\s+(\d{1,4})\s+days?\b/i;
  private static readonly DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
  private static readonly QUOTED = /["“]([^"”]{1,120})["”]/;

  extract(text: string, inputs: readonly DeclaredUseCaseInput[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const input of inputs) {
      const value = this.valueFor(input.name.toLowerCase(), text);
      if (value) result[input.name] = value;
    }

    return result;
  }

  private valueFor(key: string, text: string): string | undefined {
    if (/e-?mail|recipient/.test(key)) return text.match(UseCaseInputExtractor.EMAIL)?.[0];
    if (/days/.test(key)) return text.match(UseCaseInputExtractor.LAST_N_DAYS)?.[1];
    if (/period|range|window|since/.test(key)) {
      const days = text.match(UseCaseInputExtractor.LAST_N_DAYS)?.[1];

      return days ? `last ${ days } days` : undefined;
    }
    if (/date/.test(key)) return text.match(UseCaseInputExtractor.DATE)?.[1];
    if (/name|title|sheet|company|customer|person|project/.test(key)) return text.match(UseCaseInputExtractor.QUOTED)?.[1]?.trim() || undefined;

    return undefined;
  }
}

/** Declared fields that still need the user's (or the agent's) attention. */
export class UseCaseInputRequirements {
  missingRequired(inputs: readonly DeclaredUseCaseInput[], values: Readonly<Record<string, string>>): string[] {
    return inputs.filter(input => input.required && !values[input.name]?.trim()).map(input => input.name);
  }
}
