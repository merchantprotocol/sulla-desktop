// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentJobLivenessPolicy } from '../../../services/AgentJobLivenessPolicy';

describe('AgentJobLivenessPolicy', () => {
  const policy = new AgentJobLivenessPolicy();
  it('does not classify a brand-new job with no check-in as stalled during its grace period', () => {
    // risk: orchestration liveness — a fresh worker must not be reaped before it can report.
    expect(policy.isStalled({ createdAt: 0, startedAt: 0, lastActivityAt: 0, hasCheckin: false, now: 60_000 })).toBe(false);
  });
  it('keeps the Live Agents quiet classifier clear for a one-minute-old job without a check-in', () => {
    // risk: orchestration liveness — the renderer must use this shared policy rather than its old eight-minute threshold.
    expect(policy.isStalled({ createdAt: 0, startedAt: 0, lastActivityAt: 0, hasCheckin: false, now: 60_000 })).toBe(false);
  });
  it('applies the ten-minute no-check-in floor even when a watcher is configured for one minute', () => {
    // risk: orchestration liveness — local watcher settings must not reap a fresh spawn.
    expect(policy.isStalled({ createdAt: 0, startedAt: 0, lastActivityAt: 0, hasCheckin: false, now: 2 * 60_000, stallMs: 60_000 })).toBe(false);
  });
  it('classifies a no-check-in job as stalled after the grace and stall thresholds', () => {
    // risk: orchestration liveness — genuinely abandoned workers still need attention.
    expect(policy.isStalled({ createdAt: 0, startedAt: 0, lastActivityAt: 0, hasCheckin: false, now: 11 * 60_000 })).toBe(true);
  });

  it('reaps only old hidden non-parked work with no live graph', () => {
    // risk: stale orchestration rows must settle without killing active or intentionally parked work.
    const stale = { createdAt: 0, startedAt: 0, lastActivityAt: 0, hasCheckin: false, now: 2 * 60 * 60_000,
      hasLiveGraph: false, isTab: false, isParked: false, lostAfterMs: 2 * 60 * 60_000 };
    expect(policy.isLost(stale)).toBe(true);
    expect(policy.isLost({ ...stale, hasLiveGraph: true })).toBe(false);
    expect(policy.isLost({ ...stale, isTab: true })).toBe(false);
    expect(policy.isLost({ ...stale, isParked: true })).toBe(false);
    expect(policy.isLost({ ...stale, now: stale.now - 1 })).toBe(false);
  });

  it('uses recent check-ins to preserve a long-running job', () => {
    // risk: valid long sessions must not be marked lost just because their row is old.
    expect(policy.isLost({ createdAt: 0, startedAt: 0, lastActivityAt: 2 * 60 * 60_000 - 1,
      hasCheckin: true, now: 2 * 60 * 60_000, hasLiveGraph: false, isTab: false, isParked: false,
      lostAfterMs: 2 * 60 * 60_000 })).toBe(false);
  });
});
