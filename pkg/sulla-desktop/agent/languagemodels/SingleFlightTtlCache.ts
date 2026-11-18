// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * A time-limited value plus one shared in-flight load. Concurrent callers join the same load
 * instead of starting another. State lives on the instance, so each catalog owns its own cache.
 */
export class SingleFlightTtlCache<T> {
  private entry: { at: number; value: T } | null = null;
  private flight: Promise<T> | null = null;

  constructor(private readonly ttlMs: number) {}

  /** The stored value while it is still within the TTL, otherwise undefined. */
  fresh(): T | undefined {
    return this.entry && Date.now() - this.entry.at < this.ttlMs ? this.entry.value : undefined;
  }

  store(value: T): void {
    this.entry = { at: Date.now(), value };
  }

  clear(): void {
    this.entry = null;
  }

  /** Join the load already in flight, or start `load` when none is running. */
  join(load: () => Promise<T>): Promise<T> {
    if (!this.flight) {
      this.flight = load().finally(() => { this.flight = null; });
    }
    return this.flight;
  }
}
