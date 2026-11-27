// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BaseThreadState, Graph } from '../nodes/Graph';

export interface ThreadGraphRecord {
  graph: Graph<any>;
  state: BaseThreadState;
}

/** Bounded in-memory graph cache; durable state is written before eviction. */
export class ThreadGraphCache {
  private readonly records = new Map<string, { record: ThreadGraphRecord; lastAccessAt: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;

  constructor(
    private readonly save: (state: BaseThreadState) => Promise<void>,
    private readonly isPinned: (state: BaseThreadState) => boolean,
    private readonly now: () => number = Date.now,
    private readonly idleMs = 15 * 60_000,
    private readonly maxIdleEntries = 12,
  ) {}

  get size(): number { return this.records.size; }
  has(threadId: string): boolean { return this.records.has(threadId); }
  get(threadId: string): ThreadGraphRecord | undefined {
    const entry = this.records.get(threadId);
    if (!entry) return undefined;
    entry.lastAccessAt = this.now();
    this.records.delete(threadId);
    this.records.set(threadId, entry);
    return entry.record;
  }
  set(threadId: string, record: ThreadGraphRecord): void {
    this.records.delete(threadId);
    this.records.set(threadId, { record, lastAccessAt: this.now() });
    this.ensureSweep();
  }
  delete(threadId: string): void { this.records.delete(threadId); }
  entries(): Array<[string, ThreadGraphRecord]> {
    return [...this.records].map(([key, entry]) => [key, entry.record]);
  }
  clear(): void {
    this.records.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async evictIdle(): Promise<string[]> {
    if (this.sweepInFlight) return [];
    this.sweepInFlight = true;
    try {
      const now = this.now();
      const idle = [...this.records].filter(([, entry]) => this.isIdle(entry));
      const eligible = idle.filter(([, entry]) => !this.isPinned(entry.record.state));
      // Idle capacity limits apply only to graphs we can actually release.
      const evictable = eligible.filter(([, entry]) => !this.hasLiveRunner(entry.record.state));
      const expired = (entry: { lastAccessAt: number }) => now - entry.lastAccessAt > this.idleMs;
      const stale = new Set(evictable.filter(([, entry]) => expired(entry)).map(([key]) => key));
      const excess = Math.max(0, evictable.length - this.maxIdleEntries);
      for (const [key] of evictable) {
        if (stale.size >= excess) break;
        stale.add(key);
      }
      const candidates = eligible.filter(([key, entry]) => stale.has(key) || expired(entry));
      const evicted: string[] = [];
      for (const [threadId, entry] of candidates) {
        if (this.records.get(threadId)?.record !== entry.record || !this.isIdle(entry) || this.isPinned(entry.record.state)) continue;
        try {
          await this.save(entry.record.state);
          // A parked runner still owns this exact state. Check after persistence
          // in case ownership changed while saving; checkpoint again after TTL.
          if (this.hasLiveRunner(entry.record.state)) {
            entry.lastAccessAt = this.now();
            continue;
          }
          // A run may have started while persistence was in flight. Re-check before
          // dropping the live graph; the state is safe on disk but the cache is not.
          if (this.records.get(threadId)?.record === entry.record && this.isIdle(entry) && !this.isPinned(entry.record.state)) {
            this.records.delete(threadId);
            evicted.push(threadId);
          }
        } catch {
          // Keep the graph available if its latest state could not be made durable.
        }
      }
      return evicted;
    } finally {
      this.sweepInFlight = false;
    }
  }

  private isIdle(entry: { record: ThreadGraphRecord; lastAccessAt: number }): boolean {
    const metadata = entry.record.state.metadata as any;
    return metadata?.cycleComplete === true
      && metadata?.waitingForUser !== true;
  }

  private hasLiveRunner(state: BaseThreadState): boolean {
    const metadata = state.metadata as typeof state.metadata & { runtimeRunnerActive?: boolean; delegatedRunActive?: boolean };
    return metadata?.runtimeRunnerActive === true || metadata?.delegatedRunActive === true;
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.evictIdle(); }, Math.min(this.idleMs, 60_000));
    this.sweepTimer.unref?.();
  }
}
