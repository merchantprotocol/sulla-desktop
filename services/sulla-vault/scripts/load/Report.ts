// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface LatencySummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

/** JSON-safe report formatting and quantiles; no per-request body or identity data is retained. */
export class LoadReport {
  static latency(values: number[]): LatencySummary {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!sorted.length) return { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null };
    const percentile = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 100) / 100;
    return {
      count: sorted.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      minMs: Math.round(sorted[0] * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    };
  }

  static mib(bytes: number | null | undefined): number | null {
    return bytes === null || bytes === undefined || !Number.isFinite(bytes) ? null : Math.round(bytes / (1024 * 1024) * 100) / 100;
  }

  static round(value: number, precision = 2): number {
    const scale = 10 ** precision;
    return Math.round(value * scale) / scale;
  }
}
