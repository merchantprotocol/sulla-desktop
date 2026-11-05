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

/** Serializes one parent/label key so concurrent retries cannot both create jobs. */
export class SpawnDedupeGuard {
  static readonly WINDOW_MS = 30_000;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly clock: Clock, private readonly windowMs = SpawnDedupeGuard.WINDOW_MS) {}

  isEligible(candidate: SpawnDedupeCandidate): boolean {
    const age = this.clock.now().getTime() - candidate.createdAt;
    return age >= 0 && age <= this.windowMs && candidate.status !== 'stopped';
  }

  async run<T>(key: string | undefined, find: () => Promise<T | undefined>, create: () => Promise<T>): Promise<SpawnDedupeResult<T>> {
    if (!key) return { value: await create(), deduplicated: false };
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, previous.then(() => current));
    await previous;
    try {
      const existing = await find();
      if (existing !== undefined) return { value: existing, deduplicated: true };
      return { value: await create(), deduplicated: false };
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}
