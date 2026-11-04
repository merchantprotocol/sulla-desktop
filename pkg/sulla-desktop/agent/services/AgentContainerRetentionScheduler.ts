// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RetentionReport } from './AgentContainerRetentionPolicy';

/** Narrow view of `ContainerRetentionPolicy` the scheduler needs — easy to fake in tests. */
export interface RetentionEnforcer { enforce(): Promise<RetentionReport>; }

export interface RetentionSchedulerTimer {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface RetentionSchedulerLogger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * Runs the retention policy on a timer: once immediately on `start()`, then
 * every `intervalMs`. The next run is armed only after the current one
 * settles, so runs never overlap even if `runNow()` is also called by hand
 * while a scheduled run is in flight.
 */
export class ContainerRetentionScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly enforcer:    RetentionEnforcer,
    private readonly timerSource: RetentionSchedulerTimer,
    private readonly logger:      RetentionSchedulerLogger,
    private readonly intervalMs:  number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.runAndReschedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.timerSource.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Runs a pass now, sharing a single in-flight run with the scheduled loop. */
  async runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runAndReschedule(): Promise<void> {
    await this.runNow();
    if (this.stopped) return;
    this.timer = this.timerSource.setTimeout(() => {
      this.timer = null;
      void this.runAndReschedule();
    }, this.intervalMs);
  }

  private async runOnce(): Promise<void> {
    try {
      const report = await this.enforcer.enforce();
      this.logger.info(
        `[ContainerRetention] removed=${ report.removed.length } kept=${ report.keptCount } errors=${ report.errors.length }`,
      );
    } catch (error) {
      this.logger.error(`[ContainerRetention] enforce failed: ${ (error as Error).message }`);
    }
  }
}
