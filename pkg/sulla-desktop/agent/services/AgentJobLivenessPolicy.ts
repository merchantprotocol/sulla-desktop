// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Shared liveness rules for agent jobs. New jobs get time to check in. */
export class AgentJobLivenessPolicy {
  constructor(private readonly newJobGraceMs = 10 * 60_000, private readonly stallMs = 15 * 60_000) {}

  isStalled(input: { createdAt: number; startedAt: number; lastActivityAt: number; hasCheckin: boolean; now: number; stallMs?: number }): boolean {
    if (!input.hasCheckin) return input.now - input.createdAt >= this.newJobGraceMs;
    return input.now - Math.max(input.lastActivityAt, input.startedAt) >= (input.stallMs ?? this.stallMs);
  }

  /** A periodic lost-job sweep may settle only stale, hidden, unparked work with no live graph. */
  isLost(input: { createdAt: number; startedAt: number; lastActivityAt: number; hasCheckin: boolean; now: number;
    hasLiveGraph: boolean; isTab: boolean; isParked: boolean; lostAfterMs: number }): boolean {
    if (input.hasLiveGraph || input.isTab || input.isParked) return false;
    const lastActivityAt = Math.max(input.lastActivityAt, input.startedAt, input.createdAt);
    return input.now - lastActivityAt >= Math.max(this.newJobGraceMs, input.lostAfterMs)
      && (!input.hasCheckin || input.now - input.lastActivityAt >= input.lostAfterMs);
  }
}
