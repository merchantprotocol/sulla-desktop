// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface SupervisedDriver {
  running: boolean;
  startedAt?: number | null;
  lastAttemptAt: number | null;
  /** Time the driver said it would next tick or reconcile. Preferred over lastAttemptAt when present. */
  scheduledNextAt?: number | null;
  intervalMs: number;
  restart(): void;
}

/** How long past its scheduled time a running driver may stay silent before it counts as stalled. */
export const SYNC_DRIVER_STALL_GRACE_MS = 2 * 60_000;

/** Reconciles desired state with observable driver liveness and attempt age. */
export class SyncDriverSupervisor {
  private timer:ReturnType<typeof setInterval>|null=null;
  constructor(private readonly now: () => number = () => Date.now()) {}

  start(reconcile:()=>void):void {
    if(this.timer)return;
    this.timer=setInterval(reconcile,30_000);
    this.timer.unref?.();
  }

  stop():void {
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
  }

  reconcile(driver: SupervisedDriver, shouldBeActive: boolean): boolean {
    if (!shouldBeActive) return false;
    const stale = this.isStale(driver);
    if (driver.running && !stale) return false;
    driver.restart();
    return true;
  }

  // A driver that schedules its own next wake is stale only when that wake is overdue.
  // Backoff and not-ready waits are quiet on purpose, so attempt age alone is not a stall.
  private isStale(driver: SupervisedDriver): boolean {
    if (driver.scheduledNextAt != null) {
      return this.now() > driver.scheduledNextAt + SYNC_DRIVER_STALL_GRACE_MS;
    }
    const referenceAt = driver.lastAttemptAt ?? driver.startedAt ?? null;
    return referenceAt !== null && this.now() - referenceAt > driver.intervalMs * 3;
  }
}
