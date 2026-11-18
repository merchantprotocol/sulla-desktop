// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const perfLog = vi.hoisted(() => vi.fn());

vi.mock('@pkg/utils/logging', () => ({
  default: { perf: { log: perfLog } },
}));

import { TurnHopTiming } from '../../utils/turnHopTiming';

const stateFor = (threadId: string) => ({ metadata: { threadId } });

describe('TurnHopTiming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    perfLog.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs one TurnHop line with marks in order and relative ms after a begun turn', () => {
    // risk: money-free perf instrumentation; guards the per-hop latency breakdown we rely on
    const state = stateFor('thread-order');
    TurnHopTiming.begin(state, 1_000);

    vi.setSystemTime(1_005);
    TurnHopTiming.mark(state, 'a');
    vi.setSystemTime(1_010);
    TurnHopTiming.mark(state, 'b');
    vi.setSystemTime(1_020);
    TurnHopTiming.emitProviderStart(state, 'claude', 3);

    expect(perfLog).toHaveBeenCalledTimes(1);
    expect(perfLog).toHaveBeenCalledWith(
      '[TurnHop] threadId=thread-order provider=claude msgs=3 marks=[a=+5ms(5ms), b=+10ms(5ms), provider.run.start=+20ms(10ms)]',
    );
  });

  it('does not recreate a record for marks after emit, and a new begin starts from its own receivedAt', () => {
    // risk: stale turn timing leaking into the next turn's [TurnHop] line
    const state = stateFor('thread-stale');
    TurnHopTiming.begin(state, 1_000);
    vi.setSystemTime(1_010);
    TurnHopTiming.emitProviderStart(state, 'codex', 1);
    expect(perfLog).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_050);
    TurnHopTiming.mark(state, 'AgentNode.normalizedChat.end');
    TurnHopTiming.firstEvent(state, 'first.text');
    TurnHopTiming.emitProviderStart(state, 'codex', 1);
    // firstEvent always logs its own event line; the second emit must log nothing
    expect(perfLog).toHaveBeenCalledTimes(2);
    expect(String(perfLog.mock.calls[1][0]).startsWith('[TurnHop] threadId=thread-stale event=first.text')).toBe(true);
    const marksLines = perfLog.mock.calls.filter(([line]) => String(line).includes('marks='));
    expect(marksLines).toHaveLength(1);

    vi.setSystemTime(2_000);
    TurnHopTiming.begin(state, 2_000);
    vi.setSystemTime(2_003);
    TurnHopTiming.emitProviderStart(state, 'codex', 2);
    expect(perfLog).toHaveBeenLastCalledWith(
      '[TurnHop] threadId=thread-stale provider=codex msgs=2 marks=[provider.run.start=+3ms(3ms)]',
    );
  });

  it('is a no-op when mark runs without a begun turn', () => {
    // risk: marks from error paths or non-turn code must not create records
    const state = stateFor('thread-no-begin');
    TurnHopTiming.mark(state, 'orphan');
    TurnHopTiming.emitProviderStart(state, 'claude', 1);
    expect(perfLog).not.toHaveBeenCalled();
  });

  it('caps tracked threads and marks per turn', () => {
    // risk: unbounded memory growth in a long-running desktop process
    const evictedState = stateFor('thread-cap-0');
    TurnHopTiming.begin(evictedState, 1_000);
    for (let i = 1; i <= 500; i++) TurnHopTiming.begin(stateFor(`thread-cap-${ i }`), 1_000);

    TurnHopTiming.mark(evictedState, 'late');
    TurnHopTiming.emitProviderStart(evictedState, 'claude', 1);
    expect(perfLog).not.toHaveBeenCalled();

    const cappedState = stateFor('thread-marks');
    TurnHopTiming.begin(cappedState, 1_000);
    for (let i = 0; i < 300; i++) TurnHopTiming.mark(cappedState, `m${ i }`);
    TurnHopTiming.emitProviderStart(cappedState, 'claude', 1);
    const line = String(perfLog.mock.calls[0][0]);
    expect(line.match(/=\+/g)?.length).toBe(256);
  });

  it('never throws on missing state', () => {
    // risk: timing helpers must not break a turn when state is absent
    expect(() => TurnHopTiming.begin(undefined, 1_000)).not.toThrow();
    expect(() => TurnHopTiming.mark(undefined, 'x')).not.toThrow();
    expect(() => TurnHopTiming.mark(null, 'x', 2)).not.toThrow();
    expect(() => TurnHopTiming.firstEvent(undefined, 'first.stream')).not.toThrow();
    expect(() => TurnHopTiming.emitProviderStart(undefined, 'claude', 0)).not.toThrow();
  });
});
