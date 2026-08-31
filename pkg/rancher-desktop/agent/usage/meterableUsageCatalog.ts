/** The only usage dimensions Sulla Desktop may accrue locally. */
export const METERABLE_USAGE_CATALOG = {
  aiTokens: { key: 'ai_tokens', label: 'AI tokens', unit: 'tokens' },
  transcriptionMinutes: { key: 'transcription_minutes', label: 'Transcription minutes', unit: 'minutes' },
} as const;

export type MeterableUsageDimension = typeof METERABLE_USAGE_CATALOG[keyof typeof METERABLE_USAGE_CATALOG]['key'];

export function isMeterableUsageDimension(value: string): value is MeterableUsageDimension {
  return Object.values(METERABLE_USAGE_CATALOG).some(entry => entry.key === value);
}
