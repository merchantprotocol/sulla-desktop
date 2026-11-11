// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Short-lived, instance-held TTL cache for team-recall directory reads. */
export class TeamRecallDirectoryCache {
  private readonly values = new Map<string, { loadedAt: number; value: unknown }>();
  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}
  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && this.now() - cached.loadedAt < this.ttlMs) return cached.value as T;
    const value = await load();
    this.values.set(key, { loadedAt: this.now(), value });
    return value;
  }
  invalidate(): void { this.values.clear(); }
}
