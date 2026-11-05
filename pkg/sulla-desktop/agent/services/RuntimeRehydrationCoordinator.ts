// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface RuntimeRehydrationSchedule { after(delayMs: number, action: () => void): void; }
class TimerRuntimeRehydrationSchedule implements RuntimeRehydrationSchedule {
  after(delayMs: number, action: () => void): void { const timer = setTimeout(action, delayMs); timer.unref?.(); }
}

/** Owns fail-closed runtime inventory and retries transient Docker failures. */
export class RuntimeRehydrationCoordinator {
  private readyValue = false;
  private running?: Promise<void>;
  private failures = 0;
  private lastError?: Error;
  constructor(private readonly rehydrate: () => Promise<void>, private readonly reconcile: () => Promise<unknown>,
    private readonly schedule: RuntimeRehydrationSchedule = new TimerRuntimeRehydrationSchedule(),
    private readonly baseDelayMs = 2_000, private readonly maxDelayMs = 60_000) {}

  start(): void { void this.retryNow(); }
  isReady(): boolean { return this.readyValue; }
  async ready(): Promise<void> {
    if (this.readyValue) return;
    const detail = this.lastError ? `: ${ this.lastError.message }` : '';
    throw new Error(`runtime inventory pending/retrying${ detail }`);
  }
  retryNow(): Promise<void> {
    if (this.readyValue) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.rehydrate().then(async() => { await this.reconcile(); this.readyValue = true; this.lastError = undefined; })
      .catch(error => { this.lastError = error instanceof Error ? error : new Error(String(error)); this.failures++;
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** Math.max(0, this.failures - 1)));
        this.schedule.after(delay, () => { void this.retryNow() });
      }).finally(() => { this.running = undefined });
    return this.running;
  }
}
