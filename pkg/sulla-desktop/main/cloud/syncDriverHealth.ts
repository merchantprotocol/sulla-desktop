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
  /** This machine has no network right now. Normal state, not an error streak. */
  offlineSince: number | null;
}

export interface SyncDriverClock { now(): number }

/** Per-driver operational state; contains timestamps and counts only, never synced data. */
export class SyncDriverHealth {
  private state: SyncDriverHealthSnapshot = {
    running: false, startedAt: null, lastAttemptAt: null, scheduledNextAt: null, lastSuccessAt: null,
    lastError: null, consecutiveFailures: 0, offlineSince: null,
  };

  constructor(private readonly clock: SyncDriverClock = { now: () => Date.now() }) {}

  setRunning(running: boolean): void {
    if (running === this.state.running) return;
    this.state = { ...this.state, running, startedAt: running ? this.clock.now() : null, scheduledNextAt: null };
  }
  attempted(): void { this.state = { ...this.state, lastAttemptAt: this.clock.now() } }
  /** Records when the driver will next wake, so quiet backoff or wait periods are not mistaken for a stall. */
  scheduledIn(delayMs: number): void { this.state = { ...this.state, scheduledNextAt: this.clock.now() + delayMs } }
  /** Returns true when this success ends an offline period. */
  succeeded(pendingLocalEdits?: number): boolean {
    const endedOffline = this.state.offlineSince !== null;
    this.state = { ...this.state, lastSuccessAt: this.clock.now(), lastError: null, consecutiveFailures: 0, offlineSince: null,
      ...(pendingLocalEdits === undefined ? {} : { pendingLocalEdits }) };
    return endedOffline;
  }
  /** A real (non-network) failure: counts toward the error streak. Returns true when it ends an offline period. */
  failed(code: string): boolean {
    const endedOffline = this.state.offlineSince !== null;
    this.state = { ...this.state, lastError: { code, at: this.clock.now() }, consecutiveFailures: this.state.consecutiveFailures + 1, offlineSince: null };
    return endedOffline;
  }
  /** A network-unreachable failure: marks the driver offline without touching the error streak. Returns true when it starts an offline period. */
  unreachable(): boolean {
    if (this.state.offlineSince !== null) return false;
    this.state = { ...this.state, offlineSince: this.clock.now() };
    return true;
  }
  setPendingLocalEdits(count: number): void { this.state = { ...this.state, pendingLocalEdits: Math.max(0, count) } }
  snapshot(): SyncDriverHealthSnapshot { return { ...this.state, lastError: this.state.lastError ? { ...this.state.lastError } : null } }
}
