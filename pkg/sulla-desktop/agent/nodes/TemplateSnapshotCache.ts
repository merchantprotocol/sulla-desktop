// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

interface TemplateSnapshotEntry {
  value: string;
  at: number;
  flight?: Promise<string>;
}

/** Prompt-template snapshots stay fresh for a minute; past that the stale value is served while one reload runs. */
const SNAPSHOT_TTL_MS = 60_000;

/**
 * Caches pre-model prompt snapshots (folder map, installed extensions) by key. A fresh entry is
 * returned as-is. A stale entry is returned immediately while one background reload runs. A missing
 * entry waits for the first load and shares it with any concurrent caller.
 */
export class TemplateSnapshotCache {
  private readonly entries = new Map<string, TemplateSnapshotEntry>();

  async get(key: string, load: () => Promise<string>): Promise<string> {
    const current = this.entries.get(key);
    if (current && Date.now() - current.at < SNAPSHOT_TTL_MS) return current.value;
    if (current?.value) {
      if (!current.flight) {
        current.flight = load().then(value => { this.entries.set(key, { value, at: Date.now() }); return value; })
          .catch(() => current.value).finally(() => { const latest = this.entries.get(key); if (latest) latest.flight = undefined; });
      }
      return current.value;
    }
    if (current?.flight) return current.flight;
    const entry: TemplateSnapshotEntry = { value: '', at: 0, flight: undefined };
    entry.flight = load().then(value => { this.entries.set(key, { value, at: Date.now() }); return value; })
      .finally(() => { const latest = this.entries.get(key); if (latest) latest.flight = undefined; });
    this.entries.set(key, entry);
    return entry.flight;
  }
}

export const templateSnapshotCache = new TemplateSnapshotCache();
