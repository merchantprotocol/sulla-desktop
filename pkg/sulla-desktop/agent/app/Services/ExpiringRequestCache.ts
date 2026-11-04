// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Clock } from '@sulla/foundation';

export interface CacheLoad<T> {
  value: T;
  ttlMs: number;
}

interface CacheEntry<T> extends CacheLoad<T> {
  storedAt: number;
}

export class ExpiringRequestCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly clock: Clock,
    private readonly maxEntries: number,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
  }

  async getOrLoad(key: string, loader: () => Promise<CacheLoad<T>>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && this.clock.now().getTime() - cached.storedAt < cached.ttlMs) {
      this.touch(this.entries, key, cached);
      return cached.value;
    }
    if (cached) this.entries.delete(key);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const request = loader().then(({ value, ttlMs }) => {
      this.setBounded(this.entries, key, { value, ttlMs, storedAt: this.clock.now().getTime() });
      return value;
    }).finally(() => {
      if (this.inflight.get(key) === request) this.inflight.delete(key);
    });
    this.setBounded(this.inflight, key, request);
    return request;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get pendingSize(): number {
    return this.inflight.size;
  }

  private touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
  }

  private setBounded<V>(map: Map<string, V>, key: string, value: V): void {
    this.touch(map, key, value);
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
