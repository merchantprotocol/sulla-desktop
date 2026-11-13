// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// SubconsciousWriterGate.ts
//
// Process-wide gate for post-turn subconscious writers (the v7 memory pipeline
// and the Reflex Trainer). Every conversation in this backend process — chat,
// mobile relay, Heartbeat, agent workers — funnels its post-turn writers here.
//
// Three guarantees:
//   1. Bounded concurrency: at most `maxConcurrent` writers run at once, so a
//      burst of finished turns cannot starve the primary turn's model call.
//   2. Single-flight per key with coalescing: a keyed job (one conversation's
//      memory pipeline) never runs twice at once. A newer submission for the
//      same key replaces the one still waiting, because the newest transcript
//      already contains every older turn. At most one job per key is ever
//      waiting.
//   3. Bounded, expiring queue: the waiting list never grows past `maxQueued`
//      (the oldest waiter is dropped first) and a waiter older than
//      `queuedTtlMs` is discarded instead of run late.
//
// Pure logic: no I/O, injected clock. Callers decide what to log from the
// returned outcome; submit() never rejects.

export type WriterGateOutcome = 'ran' | 'failed' | 'coalesced' | 'dropped' | 'expired';

export interface SubconsciousWriterGateOptions {
  maxConcurrent: number;
  maxQueued:     number;
  queuedTtlMs:   number;
  now?:          () => number;
}

interface WaitingJob {
  key:        string | null;
  run:        () => Promise<unknown>;
  enqueuedAt: number;
  settle:     (outcome: WriterGateOutcome) => void;
}

export class SubconsciousWriterGate {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly queuedTtlMs: number;
  private readonly now: () => number;
  private readonly waiting: WaitingJob[] = [];
  private readonly runningKeys = new Set<string>();
  private active = 0;

  constructor(options: SubconsciousWriterGateOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent);
    this.maxQueued = Math.max(1, options.maxQueued);
    this.queuedTtlMs = Math.max(1, options.queuedTtlMs);
    this.now = options.now ?? Date.now;
  }

  /**
   * Submit a writer. `key` = null means no per-key single-flight (it still
   * counts against concurrency and the queue bound). Resolves once the job
   * ran, failed, or was coalesced/dropped/expired without running.
   */
  submit(key: string | null, run: () => Promise<unknown>): Promise<WriterGateOutcome> {
    return new Promise<WriterGateOutcome>((resolve) => {
      const job: WaitingJob = { key, run, enqueuedAt: this.now(), settle: resolve };

      if (key !== null) {
        const index = this.waiting.findIndex(waiter => waiter.key === key);
        if (index >= 0) {
          // Coalesce: the newer transcript supersedes the waiting one.
          const [replaced] = this.waiting.splice(index, 1, job);
          replaced.settle('coalesced');
          this.pump();
          return;
        }
      }

      if (this.waiting.length >= this.maxQueued) {
        this.waiting.shift()?.settle('dropped');
      }
      this.waiting.push(job);
      this.pump();
    });
  }

  /** Occupancy snapshot for logs and tests. */
  snapshot(): { active: number; waiting: number; runningKeys: string[] } {
    return { active: this.active, waiting: this.waiting.length, runningKeys: [...this.runningKeys] };
  }

  private pump(): void {
    this.expireStale();
    while (this.active < this.maxConcurrent) {
      const index = this.waiting.findIndex(job => job.key === null || !this.runningKeys.has(job.key));
      if (index < 0) return;
      const [job] = this.waiting.splice(index, 1);
      this.start(job);
    }
  }

  private expireStale(): void {
    const cutoff = this.now() - this.queuedTtlMs;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i].enqueuedAt < cutoff) {
        const [expired] = this.waiting.splice(i, 1);
        expired.settle('expired');
      }
    }
  }

  private start(job: WaitingJob): void {
    this.active++;
    if (job.key !== null) this.runningKeys.add(job.key);
    let outcome: WriterGateOutcome = 'ran';
    Promise.resolve()
      .then(job.run)
      .catch(() => { outcome = 'failed' })
      .finally(() => {
        this.active--;
        if (job.key !== null) this.runningKeys.delete(job.key);
        job.settle(outcome);
        this.pump();
      });
  }
}

/**
 * The process-wide gate. 3 concurrent writers, at most 16 waiting, and a
 * waiter older than 10 minutes is stale (a newer turn will re-submit anyway).
 */
export const subconsciousWriterGate = new SubconsciousWriterGate({
  maxConcurrent: 3,
  maxQueued:     16,
  queuedTtlMs:   10 * 60_000,
});

/** Unkeyed submission through the shared gate (Reflex Trainer). */
export async function runThroughWriterGate(run: () => Promise<unknown>): Promise<WriterGateOutcome> {
  return subconsciousWriterGate.submit(null, run);
}
