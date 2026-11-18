// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
export class ThreatProtectionLogic {
  isValidHost(value: string): boolean { return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(value.trim()); }
  megabytesToBytes(value: number): number { return Math.round(value * 1024 * 1024); }
  logRequest(search: string, verdict: string) { return { limit: 200, verdict: verdict || undefined, search: search || undefined }; }
  allowlist(value: string): string[] { return value.split(',').map(host => host.trim()).filter(Boolean); }
  formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = value;
    let unit = -1;
    do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
    return `${size.toFixed(1)} ${units[unit]}`;
  }
  countLast24Hours(entries: Array<{ ts?: string | number; verdict?: string }>, now = Date.now()): { blocked: number; injection: number } {
    const cutoff = now - 24 * 60 * 60 * 1000;
    return entries.reduce((counts, entry) => {
      const timestamp = typeof entry.ts === 'number' ? entry.ts : Date.parse(entry.ts ?? '');
      if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now) return counts;
      if (entry.verdict === 'blocked') counts.blocked += 1;
      if (entry.verdict === 'injection') counts.injection += 1;
      return counts;
    }, { blocked: 0, injection: 0 });
  }
}
