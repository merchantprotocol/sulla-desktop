// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Clock } from '@sulla/foundation';

export interface SpawnDedupeCandidate {
  createdAt: number;
  status: string;
}

export interface SpawnDedupeResult<T> {
  value: T;
  deduplicated: boolean;
}

/** A bounded, per-key mutex whose entries disappear after every waiter leaves. */
export class SpawnKeyMutex {
  private readonly locks = new Map<string, Promise<void>>();

  get activeKeyCount(): number { return this.locks.size; }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }
}

/**
 * Serializes one parent/label key so concurrent retries cannot both create jobs.
 * This mutex is process-local. Desktop currently has one agent-job writer; if
 * that ownership changes, the repository lookup and insert must become one
 * Postgres advisory-lock transaction.
 */
export class SpawnDedupeGuard {
  static readonly WINDOW_MS = 30_000;

  constructor(private readonly clock: Clock, private readonly windowMs = SpawnDedupeGuard.WINDOW_MS) {}
  private readonly mutex = new SpawnKeyMutex();

  get activeKeyCount(): number { return this.mutex.activeKeyCount; }

  isEligible(candidate: SpawnDedupeCandidate): boolean {
    const age = this.clock.now().getTime() - candidate.createdAt;
    return age >= 0 && age < this.windowMs && candidate.status !== 'stopped';
  }

  async run<T>(key: string | undefined, find: () => Promise<T | undefined>, create: () => Promise<T>): Promise<SpawnDedupeResult<T>> {
    if (!key) return { value: await create(), deduplicated: false };
    return this.mutex.run(key, async() => {
      const existing = await find();
      if (existing !== undefined) return { value: existing, deduplicated: true };
      return { value: await create(), deduplicated: false };
    });
  }
}
