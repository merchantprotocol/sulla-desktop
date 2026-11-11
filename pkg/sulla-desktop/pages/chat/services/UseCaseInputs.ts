// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Deterministic, intentionally conservative extraction for declared use-case inputs. */
export class UseCaseInputExtractor {
  extract(text: string, names: readonly string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of names) {
      const key = name.toLowerCase();
      let value: string | undefined;
      if (/email/i.test(key)) value = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
      if (/days/i.test(key)) value = text.match(/\blast\s+(\d+)\s+days?\b/i)?.[1];
      if (/date/i.test(key)) value = text.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/)?.[0];
      if (!value && /name|person|company|customer/i.test(key)) value = text.match(/["“]([^"”]+)["”]/)?.[1];
      if (value) result[name] = value;
    }
    return result;
  }
}

export interface DeclaredUseCaseInput { name: string; required?: boolean }

/** Distinguishes declared fields that still need the user's attention. */
export class UseCaseInputRequirements {
  missingRequired(inputs: readonly DeclaredUseCaseInput[], values: Readonly<Record<string, string>>): string[] {
    return inputs.filter(input => input.required && !values[input.name]?.trim()).map(input => input.name);
  }
}
