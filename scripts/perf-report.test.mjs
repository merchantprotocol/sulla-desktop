// SPDX-License-Identifier: GPL-2.0-or-later
// Run: node --test scripts/perf-report.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PerfLogReader, TurnTimingAggregator } from './perf-report.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/perf-report.log', import.meta.url));
const reader = new PerfLogReader();
const parsed = reader.parseLines(readFileSync(fixturePath, 'utf8').split(/\r?\n/));
const aggregator = new TurnTimingAggregator();
const report = aggregator.aggregate(parsed.turns, parsed.bridgeTimings);

const provider = name => report.turnTiming.find(group => group.provider === name);

test('nearest-rank percentiles select ceil(p × n), one-based', () => {
  // risk: data accuracy — nearest-rank errors misstate turn latency percentiles.
  const codex = provider('codex');
  assert.deepEqual(codex.phases.totalMs, { p50: 1000, p90: 2000, max: 2000 });
  assert.deepEqual(codex.phases.queueWaitMs, { p50: 10, p90: 20, max: 20 });
});

test('records group by provider and then by surface; filters keep the selected sample', () => {
  // risk: attribution — provider/surface mixups make the comparison misleading.
  assert.deepEqual(report.turnTiming.map(group => group.provider), ['claude', 'codex']);
  assert.deepEqual(provider('codex').surfaces.map(group => [group.surface, group.n]), [['chat', 2]]);
  const filtered = aggregator.aggregate(parsed.turns, parsed.bridgeTimings, { provider: 'codex', surface: 'chat' });
  assert.deepEqual(filtered.turnTiming.map(group => [group.provider, group.n]), [['codex', 2]]);
});

test('malformed timing and unrelated lines are skipped without entering the sample count', () => {
  // risk: data accuracy — partial/corrupt lines must not contaminate aggregate counts.
  assert.equal(parsed.skippedLines, 3);
  assert.equal(report.turnTiming.reduce((total, group) => total + group.n, 0), 3);
});

test('request and tool durations use turn-relative timestamps, not absolute offsets', () => {
  // risk: data accuracy — relative timestamps must be differenced from each step start.
  const codex = provider('codex');
  assert.deepEqual(codex.requestLatencyMs.firstByte, { p50: 100, p90: 200, max: 200 });
  assert.deepEqual(codex.requestLatencyMs.firstText, { p50: 200, p90: 600, max: 600 });
  assert.deepEqual(codex.requestLatencyMs.duration, { p50: 500, p90: 1000, max: 1000 });
  assert.deepEqual(codex.toolTimePerTurnMs, { p50: 200, p90: 500 });
  assert.ok(Math.abs(codex.timeShare.modelPercent - 50) < 1e-9);
  assert.ok(Math.abs(codex.timeShare.toolsPercent - (700 / 3000) * 100) < 1e-9);
});

test('legacy BridgeTiming records produce per-provider latency and body-size aggregates', () => {
  // risk: data accuracy — before/after request timing comparisons must use parsed values.
  assert.deepEqual(report.bridgeTiming.map(group => group.provider), ['claude', 'codex']);
  const codex = report.bridgeTiming.find(group => group.provider === 'codex');
  assert.equal(codex.n, 1);
  assert.deepEqual(codex.totalMs, { p50: 4.2, p90: 4.2 });
  assert.deepEqual(codex.firstChunkMs, { p50: 1.1, p90: 1.1 });
  assert.deepEqual(codex.bodyBytes, { p50: 1024, p90: 1024 });
});

test('since filters TurnTiming by accepted dispatch and timestamped BridgeTiming lines', () => {
  // risk: data accuracy — time-window comparisons must exclude older records consistently.
  const turnWindow = aggregator.aggregate(parsed.turns, parsed.bridgeTimings, { sinceMs: 1500, provider: 'codex' });
  assert.equal(turnWindow.turnTiming[0].n, 1);
  assert.deepEqual(turnWindow.turnTiming[0].phases.queueWaitMs, { p50: 20, p90: 20, max: 20 });

  const bridgeWindow = aggregator.aggregate(parsed.turns, parsed.bridgeTimings, {
    sinceMs: Date.parse('2026-11-27T09:30:30Z'),
    provider: 'claude',
  });
  assert.equal(bridgeWindow.turnTiming.length, 0);
  assert.deepEqual(bridgeWindow.bridgeTiming.map(group => [group.provider, group.n]), [['claude', 1]]);
});
