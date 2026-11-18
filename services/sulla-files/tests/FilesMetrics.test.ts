// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { FilesMetrics } from '../src/FilesMetrics.js';
import { RollingTimingWindow } from '../src/RollingTimingWindow.js';

describe('Files wait metrics', () => {
  // risk: diagnosis — every pool wait lands in the histogram, so a slow pool can be told apart from a slow fsync.
  it('records each pool wait into count, sum, max and window percentiles', () => {
    const logged:Record<string, unknown>[] = [];
    const metrics = new FilesMetrics({ slowWaitMs: 500, window: 4, warn: (_message, fields) => logged.push(fields) });
    [10, 20, 30, 40].forEach(ms => metrics.observePoolWait(ms));
    expect(metrics.snapshot().poolWait).toMatchObject({ count: 4, totalMs: 100, maxMs: 40, p50Ms: 20, p95Ms: 40, windowSamples: 4 });
    expect(logged).toEqual([]);
  });

  // risk: misleading percentiles — p50/p95 follow recent waits, while count, sum and max keep the whole history.
  it('keeps percentiles on the recent window and totals on every sample', () => {
    const timings = new RollingTimingWindow(3);
    [1000, 1, 2, 3].forEach(ms => timings.record(ms));
    expect(timings.snapshot()).toMatchObject({ count: 4, maxMs: 1000, p95Ms: 3, windowSamples: 3 });
  });

  // risk: misattributed latency — txn, audit and route timings land in their own windows, so the create trace can split them.
  it('records transaction, audit and FUSE route timings into their own windows', () => {
    const logged:Record<string, unknown>[] = [];
    const metrics = new FilesMetrics({ slowWaitMs: 500, window: 4, warn: (_message, fields) => logged.push(fields) });
    metrics.observeTxn(12);
    metrics.observeTxn(30);
    metrics.observeAudit(4);
    metrics.observeFuseRoute(90);
    const snapshot = metrics.snapshot();
    expect(snapshot.txn).toMatchObject({ count: 2, totalMs: 42, maxMs: 30, windowSamples: 2 });
    expect(snapshot.audit).toMatchObject({ count: 1, totalMs: 4, windowSamples: 1 });
    expect(snapshot.fuseRoute).toMatchObject({ count: 1, totalMs: 90, maxMs: 90 });
    expect(snapshot.poolWait.count).toBe(0);
    // risk: log volume — txn/audit/route timings are numbers only and never write a slow-wait line on their own.
    expect(logged).toEqual([]);
  });

  // risk: silent stalls — a single wait over the threshold gets its own log line; a fast one does not.
  it('logs one line for a stage wait over the threshold and none under it', () => {
    const logged:Record<string, unknown>[] = [];
    const metrics = new FilesMetrics({ slowWaitMs: 500, warn: (_message, fields) => logged.push(fields) });
    metrics.observeStage(499);
    metrics.observeStage(501);
    expect(logged).toEqual([{ name: 'stage', waitMs: 501, thresholdMs: 500 }]);
    expect(metrics.snapshot().stage.count).toBe(2);
  });
});
