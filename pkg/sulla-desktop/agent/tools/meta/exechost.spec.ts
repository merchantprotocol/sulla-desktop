// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { clampTimeoutMs, normalizeTimeoutMs } from '../util/timeoutUnits';

describe('normalizeTimeoutMs', () => {
  // risk: the host command gets killed early when callers pass seconds
  it('reads values under 1000 as seconds', () => {
    expect(normalizeTimeoutMs(60)).toBe(60_000);
    expect(normalizeTimeoutMs(5)).toBe(5_000);
    expect(normalizeTimeoutMs('120')).toBe(120_000);
  });

  it('keeps values of 1000 and above as milliseconds', () => {
    expect(normalizeTimeoutMs(60_000)).toBe(60_000);
    expect(normalizeTimeoutMs(120_000)).toBe(120_000);
  });

  it('clamps to a 1 s minimum and a 4 h maximum', () => {
    expect(normalizeTimeoutMs(0.5)).toBe(1_000);
    expect(normalizeTimeoutMs(999_999_999)).toBe(4 * 60 * 60_000);
    expect(clampTimeoutMs(10)).toBe(1_000);
  });

  it('falls back to the default for missing, NaN, or non-positive input', () => {
    expect(normalizeTimeoutMs(undefined)).toBe(60_000);
    expect(normalizeTimeoutMs('abc')).toBe(60_000);
    expect(normalizeTimeoutMs(NaN)).toBe(60_000);
    expect(normalizeTimeoutMs(0)).toBe(60_000);
    expect(normalizeTimeoutMs(-5)).toBe(60_000);
    expect(normalizeTimeoutMs(undefined, 120_000)).toBe(120_000);
  });
});
