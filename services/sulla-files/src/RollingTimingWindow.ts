// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface TimingSnapshot {
  /** Every sample ever recorded in this process. */
  count:number;
  totalMs:number;
  maxMs:number;
  /** Percentiles over the most recent `windowSamples` samples only. */
  p50Ms:number;
  p95Ms:number;
  windowSamples:number;
}

/**
 * Cheap in-process timing: cumulative count, sum and max, plus p50/p95 over a fixed ring of the
 * most recent samples. Recording is O(1) and allocation-free; only snapshot() sorts the window.
 */
export class RollingTimingWindow {
  private readonly samples:Float64Array;
  private next = 0;
  private filled = 0;
  private count = 0;
  private totalMs = 0;
  private maxMs = 0;

  constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('RollingTimingWindow capacity must be a positive integer');
    this.samples = new Float64Array(capacity);
  }

  record(ms:number):void {
    const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.count += 1;
    this.totalMs += value;
    this.maxMs = Math.max(this.maxMs, value);
    this.samples[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    this.filled = Math.min(this.filled + 1, this.capacity);
  }

  snapshot():TimingSnapshot {
    const window = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    return {
      count: this.count,
      totalMs: round(this.totalMs),
      maxMs: round(this.maxMs),
      p50Ms: percentile(window, 0.5),
      p95Ms: percentile(window, 0.95),
      windowSamples: this.filled,
    };
  }
}

function percentile(sorted:number[], quantile:number):number {
  if (sorted.length === 0) return 0;
  return round(sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]);
}

function round(value:number):number {
  return Math.round(value * 10) / 10;
}
