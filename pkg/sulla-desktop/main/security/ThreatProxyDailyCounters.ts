// SPDX-License-Identifier: GPL-2.0-or-later
export interface ThreatDailyCounters { scannedToday: number; blockedToday: number }

/** Sums validated UTC-hour buckets overlapping the host's local calendar day. */
export class ThreatProxyDailyCounters {
  static sumLocalDay(hours: Record<string, unknown>, now = new Date(), timezoneOffset = now.getTimezoneOffset()): ThreatDailyCounters | null {
    const localNow = new Date(now.getTime() - timezoneOffset * 60_000);
    const localStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) + timezoneOffset * 60_000;
    const localEnd = localStart + 24 * 60 * 60_000;
    let scannedToday = 0, blockedToday = 0;
    for (const [hour, counts] of Object.entries(hours)) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour) || !counts || typeof counts !== 'object') return null;
      const bucket = counts as { scanned?: unknown; blocked?: unknown };
      if (!Number.isSafeInteger(bucket.scanned) || (bucket.scanned as number) < 0 || !Number.isSafeInteger(bucket.blocked) || (bucket.blocked as number) < 0) return null;
      const instant = Date.parse(`${hour}:00:00Z`);
      if (!Number.isFinite(instant)) return null;
      if (instant >= localStart && instant < localEnd) { scannedToday += bucket.scanned as number; blockedToday += bucket.blocked as number }
    }
    return { scannedToday, blockedToday };
  }
}
