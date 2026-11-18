// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { ThreatProxyDailyCounters } from './ThreatProxyDailyCounters';

describe('threat proxy local-day hourly totals', () => {
  it('includes the UTC hours overlapping a local day across UTC midnight', () => {
    // UTC-7: local Nov 17 spans 07:00Z Nov 17 through 07:00Z Nov 18.
    expect(ThreatProxyDailyCounters.sumLocalDay({
      '2026-11-17T06': { scanned: 80, blocked: 8 },
      '2026-11-17T07': { scanned: 2, blocked: 1 },
      '2026-11-18T06': { scanned: 3, blocked: 1 },
      '2026-11-18T07': { scanned: 90, blocked: 9 },
    }, new Date('2026-11-18T03:00:00Z'), 420)).toEqual({ scannedToday: 5, blockedToday: 2 });
  });
});
