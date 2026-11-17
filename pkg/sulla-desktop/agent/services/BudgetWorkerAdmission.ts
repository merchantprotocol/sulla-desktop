// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

type WaitingTask = { resolve: (release: () => void) => void };

/** FIFO admission gate; queued tasks are never rejected or preempted. */
export class BudgetWorkerAdmission {
  private active = 0;
  private waiting: WaitingTask[] = [];
  private allowance = Number.MAX_SAFE_INTEGER;
  private externalRunning = 0;

  get queued(): number { return this.waiting.length; }
  get running(): number { return this.active; }

  async run<T>(allowance: number, operation: () => Promise<T>, externalRunning = 0): Promise<T> {
    this.allowance = Math.max(0, Math.floor(allowance));
    this.externalRunning = Math.max(0, Math.floor(externalRunning));
    const release = await this.acquire();
    try { return await operation(); } finally { release(); }
  }

  private acquire(): Promise<() => void> {
    return new Promise(resolve => {
      if (this.active + this.externalRunning < this.allowance && this.waiting.length === 0) { this.active++; resolve(this.releaseHandle()); return; }
      this.waiting.push({ resolve });
      this.drain();
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => { if (released) return; released = true; this.active--; this.drain(); };
  }

  private drain(): void {
    while (this.active + this.externalRunning < this.allowance && this.waiting.length) {
      this.active++;
      this.waiting.shift()!.resolve(this.releaseHandle());
    }
  }
}

export const budgetWorkerAdmission = new BudgetWorkerAdmission();
