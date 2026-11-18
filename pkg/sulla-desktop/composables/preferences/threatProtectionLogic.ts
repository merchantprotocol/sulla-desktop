// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_PATTERN = new RegExp(`^(?=.{1,253}$)${ LABEL }(?:\\.${ LABEL })*$`, 'i');
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrafficLogCountEntry {
  ts?:      string | number;
  verdict?: string;
}

export interface Last24HourCounts {
  blocked:   number;
  injection: number;
}

export class ThreatProtectionLogic {
  isValidHost(value: string): boolean {
    return HOST_PATTERN.test(value.trim());
  }

  megabytesToBytes(value: number): number {
    return Math.round(value * 1024 * 1024);
  }

  logRequest(search: string, verdict: string) {
    return {
      limit:   200,
      verdict: verdict || undefined,
      search:  search || undefined,
    };
  }

  allowlist(value: string): string[] {
    return value.split(',').map(host => host.trim()).filter(Boolean);
  }

  formatBytes(value: number): string {
    if (value < 1024) return `${ value } B`;
    const units = ['KB', 'MB', 'GB'];
    let size = value;
    let unit = -1;

    do {
      size /= 1024;
      unit += 1;
    } while (size >= 1024 && unit < units.length - 1);

    return `${ size.toFixed(1) } ${ units[unit] }`;
  }

  countLast24Hours(entries: TrafficLogCountEntry[], now = Date.now()): Last24HourCounts {
    const cutoff = now - DAY_MS;

    return entries.reduce((counts, entry) => {
      const timestamp = typeof entry.ts === 'number' ? entry.ts : Date.parse(entry.ts ?? '');

      if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now) return counts;
      if (entry.verdict === 'blocked') counts.blocked += 1;
      if (entry.verdict === 'injection') counts.injection += 1;

      return counts;
    }, { blocked: 0, injection: 0 });
  }
}
