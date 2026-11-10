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
  /** True while the last attempts failed because this machine has no network. Not an error streak. */
  offline: boolean;
  /** When the offline period began; null when online. */
  offlineSince: number | null;
}

export interface SyncDriverClock { now(): number }

/** What a recorded failure meant. Offline is a normal state, so it never counts toward an error streak. */
export type SyncFailureOutcome = 'error' | 'offline_started' | 'offline';

/** Classifies a failure as "this machine cannot reach the network" from its code and message. */
export class NetworkErrorClassifier {
  private static readonly OFFLINE_SIGNATURE = /upstream_failed|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH/i;

  isOffline(...details: string[]): boolean {
    return details.some(detail => NetworkErrorClassifier.OFFLINE_SIGNATURE.test(detail));
  }
}

/** Per-driver operational state; contains timestamps and counts only, never synced data. */
export class SyncDriverHealth {
  private state: Omit<SyncDriverHealthSnapshot, 'offline'> = {
    running: false, startedAt: null, lastAttemptAt: null, scheduledNextAt: null, lastSuccessAt: null,
    lastError: null, consecutiveFailures: 0, offlineSince: null,
  };

  constructor(
    private readonly clock: SyncDriverClock = { now: () => Date.now() },
    private readonly classifier: NetworkErrorClassifier = new NetworkErrorClassifier(),
  ) {}

  setRunning(running: boolean): void {
    if (running === this.state.running) return;
    this.state = { ...this.state, running, startedAt: running ? this.clock.now() : null, scheduledNextAt: null };
  }
  attempted(): void { this.state = { ...this.state, lastAttemptAt: this.clock.now() } }
  /** Records when the driver will next wake, so quiet backoff or wait periods are not mistaken for a stall. */
  scheduledIn(delayMs: number): void { this.state = { ...this.state, scheduledNextAt: this.clock.now() + delayMs } }
  /** Returns true when this success ends an offline period. */
  succeeded(pendingLocalEdits?: number): boolean {
    const recovered = this.state.offlineSince !== null;
    this.state = { ...this.state, lastSuccessAt: this.clock.now(), lastError: null, consecutiveFailures: 0, offlineSince: null,
      ...(pendingLocalEdits === undefined ? {} : { pendingLocalEdits }) };
    return recovered;
  }
  /** Network-unreachable failures mark the driver offline; anything else is an error streak. */
  failed(code: string, detail = ''): SyncFailureOutcome {
    if (this.classifier.isOffline(code, detail)) {
      const started = this.state.offlineSince === null;
      this.state = { ...this.state, offlineSince: this.state.offlineSince ?? this.clock.now() };
      return started ? 'offline_started' : 'offline';
    }
    this.state = { ...this.state, lastError: { code, at: this.clock.now() }, consecutiveFailures: this.state.consecutiveFailures + 1 };
    return 'error';
  }
  setPendingLocalEdits(count: number): void { this.state = { ...this.state, pendingLocalEdits: Math.max(0, count) } }
  snapshot(): SyncDriverHealthSnapshot {
    return { ...this.state, offline: this.state.offlineSince !== null, lastError: this.state.lastError ? { ...this.state.lastError } : null };
  }
}
