// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import timers from 'timers';

type Timers = Pick<typeof timers, 'setTimeout' | 'clearTimeout'>;

/**
 * The periodic automatic update check: whether it is on, the interval the
 * update server asked for, and the pending re-check timer.
 */
export class UpdateCheckSchedule {
  /** Mirrors application.updater.enabled; stops the periodic re-check when off. */
  autoChecks = true;
  private timer: NodeJS.Timeout | undefined;
  /** The update interval reported by the server. */
  private intervalMs = 0;

  constructor(private readonly clock: Timers = timers) {}

  get isScheduled(): boolean {
    return this.timer !== undefined;
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
  }

  /** Stops the pending re-check, if any. */
  cancel(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Replaces any pending re-check with one that runs `check` after the current interval. */
  scheduleNext(check: () => unknown): void {
    this.cancel();
    this.timer = this.clock.setTimeout(check, this.intervalMs);
  }
}
