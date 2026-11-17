// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

type AdmissionSnapshot = { allowance: number | null; running: number };
type WaitingTask = { resolve: (release: () => void) => void; snapshot: () => Promise<AdmissionSnapshot> };

/** Count hidden running tasks, excluding managers that currently own child jobs. */
export function countBudgetWorkers(jobs: Array<{ jobId: string; visibility?: string; parentJobId?: string | null; parentTaskIndex?: number | null; tasks: Array<{ status: string }> }>): number {
  return jobs.filter(job => job.visibility !== 'tab').reduce((total, job) => {
    const parentIndexes = new Set(jobs.filter(child => child.parentJobId === job.jobId)
      .map(child => child.parentTaskIndex).filter((index): index is number => index !== null && index !== undefined));
    const hasUnindexedChild = jobs.some(child => child.parentJobId === job.jobId && (child.parentTaskIndex === null || child.parentTaskIndex === undefined));
    const running = job.tasks.reduce((count, task, index) => {
      if (task.status !== 'running') return count;
      // Legacy child rows may omit the parent index; conservatively treat all
      // running tasks in that parent job as orchestration rather than workers.
      return hasUnindexedChild || parentIndexes.has(index) ? count : count + 1;
    }, 0);
    return total + running;
  }, 0);
}

/** FIFO admission gate; queued tasks are never rejected or preempted. */
export class BudgetWorkerAdmission {
  private active = 0;
  private waiting: WaitingTask[] = [];
  private draining = false;
  private drainRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  get queued(): number { return this.waiting.length; }
  get running(): number { return this.active; }

  async run<T>(snapshot: () => Promise<AdmissionSnapshot>, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(snapshot);
    try { return await operation(); } finally { release(); }
  }

  /** Call on every task settlement, including tasks started outside this gate. */
  async slotMayHaveFreed(): Promise<void> { await this.drain(); }

  private async acquire(snapshot: () => Promise<AdmissionSnapshot>): Promise<() => void> {
    return new Promise(resolve => {
      this.waiting.push({ resolve, snapshot });
      void this.drain();
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => { if (released) return; released = true; this.active--; void this.drain(); };
  }

  private async drain(): Promise<void> {
    if (this.draining) { this.drainRequested = true; return; }
    this.draining = true;
    try {
    // Reserve one slot before awaiting filesystem/database reads so concurrent
    // drain triggers cannot over-admit the same FIFO head.
    while (this.waiting.length) {
      const first = this.waiting[0];
      let state: AdmissionSnapshot;
      try { state = await first.snapshot(); } catch { state = { allowance: null, running: 0 }; }
      const limit = state.allowance == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(state.allowance));
      if (this.active + Math.max(0, state.running) >= limit) {
        this.scheduleRetry();
        return;
      }
      this.waiting.shift();
      this.active++;
      first.resolve(this.releaseHandle());
    }
    } finally {
      this.draining = false;
      if (this.drainRequested) { this.drainRequested = false; void this.drain(); }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.waiting.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.drain();
    }, 1000);
    // A queued task should not keep an otherwise idle app process alive.
    (this.retryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }
}

export const budgetWorkerAdmission = new BudgetWorkerAdmission();
