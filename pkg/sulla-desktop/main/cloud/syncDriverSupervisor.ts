// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface SupervisedDriver {
  running: boolean;
  startedAt?: number | null;
  lastAttemptAt: number | null;
  intervalMs: number;
  restart(): void;
}

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
    const referenceAt = driver.lastAttemptAt ?? driver.startedAt ?? null;
    const stale = referenceAt !== null && this.now() - referenceAt > driver.intervalMs * 3;
    if (driver.running && !stale) return false;
    driver.restart();
    return true;
  }
}
