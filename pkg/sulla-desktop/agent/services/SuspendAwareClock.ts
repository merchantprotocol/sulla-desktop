// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Wall-clock timestamps that exclude gaps where wall time advanced without the monotonic clock. */
export class SuspendAwareClock {
  private logicalTime: number;
  private previousWallTime: number;
  private previousMonotonicTime: number;

  constructor(
    private readonly wallTime: () => number = Date.now,
    private readonly monotonicTime: () => number = () => Number(process.hrtime.bigint() / 1_000_000n),
    private readonly clockSkewToleranceMs = 2_000,
  ) {
    this.logicalTime = this.previousWallTime = wallTime();
    this.previousMonotonicTime = monotonicTime();
  }

  now(): number {
    const wall = this.wallTime(), monotonic = this.monotonicTime();
    const wallElapsed = Math.max(0, wall - this.previousWallTime);
    const monotonicElapsed = Math.max(0, monotonic - this.previousMonotonicTime);
    const suspendedGap = Math.max(0, wallElapsed - monotonicElapsed - this.clockSkewToleranceMs);
    this.logicalTime += Math.max(0, wallElapsed - suspendedGap);
    this.previousWallTime = wall;
    this.previousMonotonicTime = monotonic;
    return this.logicalTime;
  }
}
