// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface SyncDriverHealthSnapshot {
  running: boolean;
  startedAt: number | null;
  lastAttemptAt: number | null;
  /** When the driver expects its next tick or reconcile; null until it schedules one. */
  scheduledNextAt: number | null;
  lastSuccessAt: number | null;
  lastError: { code: string; at: number } | null;
  consecutiveFailures: number;
  pendingLocalEdits?: number;
}

export interface SyncDriverClock { now(): number }

/** Per-driver operational state; contains timestamps and counts only, never synced data. */
export class SyncDriverHealth {
  private state: SyncDriverHealthSnapshot = {
    running: false, startedAt: null, lastAttemptAt: null, scheduledNextAt: null, lastSuccessAt: null,
    lastError: null, consecutiveFailures: 0,
  };

  constructor(private readonly clock: SyncDriverClock = { now: () => Date.now() }) {}

  setRunning(running: boolean): void {
    if (running === this.state.running) return;
    this.state = { ...this.state, running, startedAt: running ? this.clock.now() : null, scheduledNextAt: null };
  }
  attempted(): void { this.state = { ...this.state, lastAttemptAt: this.clock.now() } }
  /** Records when the driver will next wake, so quiet backoff or wait periods are not mistaken for a stall. */
  scheduledIn(delayMs: number): void { this.state = { ...this.state, scheduledNextAt: this.clock.now() + delayMs } }
  succeeded(pendingLocalEdits?: number): void {
    this.state = { ...this.state, lastSuccessAt: this.clock.now(), lastError: null, consecutiveFailures: 0,
      ...(pendingLocalEdits === undefined ? {} : { pendingLocalEdits }) };
  }
  failed(code: string): void {
    this.state = { ...this.state, lastError: { code, at: this.clock.now() }, consecutiveFailures: this.state.consecutiveFailures + 1 };
  }
  setPendingLocalEdits(count: number): void { this.state = { ...this.state, pendingLocalEdits: Math.max(0, count) } }
  snapshot(): SyncDriverHealthSnapshot { return { ...this.state, lastError: this.state.lastError ? { ...this.state.lastError } : null } }
}
