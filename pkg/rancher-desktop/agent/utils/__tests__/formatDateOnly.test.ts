import { describe, expect, it } from '@jest/globals';

import { formatDateOnly } from '../formatDateOnly';

describe('formatDateOnly', () => {
  it('formats Date objects without relying on string methods', () => {
    expect(formatDateOnly(new Date('2026-08-19T18:00:00.000Z'))).toBe('2026-08-19');
  });

  it('preserves existing ISO string behavior', () => {
    expect(formatDateOnly('2026-08-19T18:00:00.000Z')).toBe('2026-08-19');
  });

  it('returns an empty string for missing or invalid Date values', () => {
    expect(formatDateOnly(null)).toBe('');
    expect(formatDateOnly(new Date('not-a-date'))).toBe('');
  });
});
