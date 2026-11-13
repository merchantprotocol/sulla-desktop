// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// SubconsciousWriterGate.ts
//
// Process-wide concurrency gate for post-turn subconscious work: the v7 memory
// sequence (elephant draft -> goldfish -> elephant final) and the Reflex
// Trainer. Every completed conversation (chat, mobile-relay, Heartbeat, PM
// automation) funnels through the same backend process, so without a gate a
// burst of conversations finishing together fires an unbounded number of
// background LLM calls and starves the primary turn's own model call.
//
// The gate bounds three things:
//   - how many tasks run at once (maxConcurrent),
//   - how many may wait (maxQueue): when full, the OLDEST waiter is dropped,
//   - how long a task may wait (maxWaitMs): a waiter older than that expires.
// A dropped or expired task rejects with WriterGateRejectedError so the caller
// can log it. The v7 memory scheduler only advances a conversation's
// "remembered through" mark on success, so the next turn's run widens its
// window and re-covers what a dropped task would have read.

export type WriterGateRejection = 'dropped' | 'expired';

export class WriterGateRejectedError extends Error {
  constructor(readonly reason: WriterGateRejection, readonly waitedMs: number) {
    super(`subconscious writer gate ${ reason } a queued task after ${ waitedMs }ms`);
    this.name = 'WriterGateRejectedError';
  }
}

export interface SubconsciousWriterGateOptions {
  maxConcurrent?: number;
  maxQueue?:      number;
  maxWaitMs?:     number;
  now?:           () => number;
}

interface Waiter {
  enqueuedAt: number;
  start:      () => void;
  reject:     (error: WriterGateRejectedError) => void;
}

export class SubconsciousWriterGate {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(options: SubconsciousWriterGateOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.maxQueue = Math.max(0, options.maxQueue ?? 32);
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? 10 * 60_000);
    this.now = options.now ?? Date.now;
  }

  /** Runs `task` once a slot is free; rejects if it is dropped or expires while queued. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  snapshot(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiters.length };
  }

  private acquire(): Promise<void> {
    this.expireStale();
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      if (this.waiters.length >= this.maxQueue) {
        const oldest = this.waiters.shift();
        if (oldest) oldest.reject(new WriterGateRejectedError('dropped', this.now() - oldest.enqueuedAt));
        else return reject(new WriterGateRejectedError('dropped', 0));
      }
      this.waiters.push({
        enqueuedAt: this.now(),
        start:      () => { this.active++; resolve() },
        reject,
      });
    });
  }

  private release(): void {
    this.active--;
    this.expireStale();
    const next = this.waiters.shift();
    if (next) next.start();
  }

  private expireStale(): void {
    const now = this.now();
    while (this.waiters.length && now - this.waiters[0].enqueuedAt > this.maxWaitMs) {
      const stale = this.waiters.shift() as Waiter;
      stale.reject(new WriterGateRejectedError('expired', now - stale.enqueuedAt));
    }
  }
}

/** The one process-wide gate shared by every post-turn subconscious writer. */
export const subconsciousWriterGate = new SubconsciousWriterGate();

/** Runs `run` through the process-wide gate. */
export function runThroughWriterGate<T>(run: () => Promise<T>): Promise<T> {
  return subconsciousWriterGate.run(run);
}
