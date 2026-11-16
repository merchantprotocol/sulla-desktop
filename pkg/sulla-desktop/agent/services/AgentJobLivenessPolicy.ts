// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Shared liveness rules for agent jobs. New jobs get time to check in. */
export class AgentJobLivenessPolicy {
  constructor(private readonly newJobGraceMs = 10 * 60_000, private readonly stallMs = 15 * 60_000) {}

  /**
   * A job is stalled only when it is past its new-job grace AND has been idle
   * for the stall threshold. The grace is a floor, never a deadline: a job
   * with no check-in that is still streaming or running tools is active.
   */
  isStalled(input: { createdAt: number; startedAt: number; lastActivityAt: number; hasCheckin: boolean; now: number; stallMs?: number }): boolean {
    if (input.now - input.createdAt < this.newJobGraceMs) return false;
    return this.idleMs(input) >= (input.stallMs ?? this.stallMs);
  }

  /** How long the job has been silent: since its last activity, or since it started if it never did anything. */
  idleMs(input: { createdAt: number; startedAt: number; lastActivityAt: number; now: number }): number {
    return Math.max(0, input.now - Math.max(input.lastActivityAt, input.startedAt, input.createdAt));
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
