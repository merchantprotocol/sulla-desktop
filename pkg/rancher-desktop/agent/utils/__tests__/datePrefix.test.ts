import { describe, expect, it } from '@jest/globals';

import { datePrefix } from '../datePrefix';

describe('datePrefix', () => {
  // Regression: node-postgres hydrates TIMESTAMPTZ into a JS Date at runtime
  // even though our model records type created_at as `string`. Formatting code
  // that called `created_at.slice(0, 10)` threw `slice is not a function`,
  // silently killing observation/identity injection. datePrefix must accept a
  // Date without throwing.
  it('formats a Date to YYYY-MM-DD (the runtime case that broke injection)', () => {
    expect(datePrefix(new Date('2026-08-19T21:23:08.655Z'))).toBe('2026-08-19');
  });

  it('formats an ISO string to YYYY-MM-DD', () => {
    expect(datePrefix('2026-08-19T21:23:08.655Z')).toBe('2026-08-19');
  });

  it('returns empty string for null/undefined/non-date values', () => {
    expect(datePrefix(null)).toBe('');
    expect(datePrefix(undefined)).toBe('');
    expect(datePrefix(12345)).toBe('');
  });
});
