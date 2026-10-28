// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The only usage dimensions Sulla Desktop may accrue locally. */
export const METERABLE_USAGE_CATALOG = {
  aiTokens: { key: 'ai_tokens', label: 'AI tokens', unit: 'tokens' },
  transcriptionMinutes: { key: 'transcription_minutes', label: 'Transcription minutes', unit: 'minutes' },
} as const;

export type MeterableUsageDimension = typeof METERABLE_USAGE_CATALOG[keyof typeof METERABLE_USAGE_CATALOG]['key'];

export function isMeterableUsageDimension(value: string): value is MeterableUsageDimension {
  return Object.values(METERABLE_USAGE_CATALOG).some(entry => entry.key === value);
}
