// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { RunActivityTracker } from '@pkg/agent/services/RunActivity';

describe('RunActivityTracker action counts', () => {
  it('keeps token/liveness touches out of the cumulative discrete-action count', () => {
    // risk: streamed token deltas inflate the visible agent activity meter
    let now = 1_000;
    const tracker = new RunActivityTracker(
      { acquire: () => undefined, release: () => undefined },
      { inFlight: () => undefined, clearKey: () => undefined },
      () => now,
    );
    const metadata = { activityKeys: ['parent#0', 'job#0'] };
    for (let token = 0; token < 50; token++) {
      now++;
      tracker.touch(metadata);
    }
    expect(tracker.actionCount('job#0')).toBe(0);

    tracker.recordAction('job#0', 'request_start');
    tracker.recordAction('job#0', 'tool_start');
    tracker.recordAction('job#0', 'tool_end');

    expect(tracker.actionCount('job#0')).toBe(3);
    expect(tracker.actionCount('parent#0')).toBe(0);
    expect(tracker.lastActivityAt('job#0')).toBe(now);
  });

  it('counts only legacy touches explicitly tagged as a tool start or result', () => {
    // risk: fallback counting tokens as actions overstates activity, or drops existing tagged tool boundaries
    const tracker = new RunActivityTracker(
      { acquire: () => undefined, release: () => undefined },
      { inFlight: () => undefined, clearKey: () => undefined },
      () => 2_000,
    );
    tracker.touch({ activityKeys: ['parent#0', 'job#1'], activityAction: 'tool_start' });
    tracker.touch({ activityKeys: ['parent#0', 'job#1'], phase: 'tool_result' });
    tracker.touch({ activityKeys: ['parent#0', 'job#1'] });
    tracker.touch({ activityKeys: ['parent#0', 'job#1'], kind: 'token' });

    expect(tracker.actionCount('job#1')).toBe(2);
    expect(tracker.actionCount('parent#0')).toBe(0);
  });
});
