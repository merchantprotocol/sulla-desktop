// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface RuntimeRehydrationTimer { cancel(): void; }
export interface RuntimeRehydrationSchedule { after(delayMs: number, action: () => void): RuntimeRehydrationTimer; }
class TimerRuntimeRehydrationSchedule implements RuntimeRehydrationSchedule {
  after(delayMs: number, action: () => void): RuntimeRehydrationTimer {
    const timer = setTimeout(action, delayMs); timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }
}

/** Owns fail-closed runtime inventory and retries transient Docker failures. */
export class RuntimeRehydrationCoordinator {
  private readyValue = false;
  private running?: Promise<void>;
  private failures = 0;
  private lastError?: Error;
  private pendingRetry?: RuntimeRehydrationTimer;
  private stopped = false;
  constructor(private readonly rehydrate: () => Promise<void>, private readonly reconcile: () => Promise<unknown>,
    private readonly schedule: RuntimeRehydrationSchedule = new TimerRuntimeRehydrationSchedule(),
    private readonly baseDelayMs = 2_000, private readonly maxDelayMs = 60_000) {}

  start(): void { if (!this.stopped) void this.retryNow(); }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingRetry?.cancel();
    this.pendingRetry = undefined;
  }
  isReady(): boolean { return this.readyValue; }
  async ready(): Promise<void> {
    if (this.readyValue) return;
    const detail = this.lastError ? `: ${ this.lastError.message }` : '';
    throw new Error(`runtime inventory pending/retrying${ detail }`);
  }
  retryNow(): Promise<void> {
    if (this.stopped || this.readyValue) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.rehydrate().then(async() => {
      if (this.stopped) return;
      await this.reconcile();
      if (this.stopped) return;
      this.readyValue = true; this.lastError = undefined;
    })
      .catch(error => {
        if (this.stopped) return;
        this.lastError = error instanceof Error ? error : new Error(String(error)); this.failures++;
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** Math.max(0, this.failures - 1)));
        this.pendingRetry = this.schedule.after(delay, () => { this.pendingRetry = undefined; void this.retryNow() });
      }).finally(() => { this.running = undefined });
    return this.running;
  }
}
