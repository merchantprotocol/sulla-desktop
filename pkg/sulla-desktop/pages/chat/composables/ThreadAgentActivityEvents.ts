/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */
import { ref } from 'vue';
import type { StatusRollupItem } from '../components/composer/StatusRollupQueue';

/** Diffs mutable source projections while retaining only the previous projection's keys. */
export class ThreadAgentEventProjectionDiff {
  private previousKeys = new Set<string>();

  get retainedKeyCount(): number {
    return this.previousKeys.size;
  }

  has(key: string): boolean {
    return this.previousKeys.has(key);
  }

  diff(items: readonly StatusRollupItem[]): StatusRollupItem[] {
    const currentKeys = new Set<string>();
    const projectionKeys = new Set<string>();
    const emitted: StatusRollupItem[] = [];
    for (const item of items) {
      if (projectionKeys.has(item.key)) continue;
      projectionKeys.add(item.key);
      currentKeys.add(item.key);
      if (this.previousKeys.has(item.key)) {
        if (item.kind === 'thought') emitted.push({ ...item, updateOnly: true });
      } else {
        emitted.push(item);
      }
    }
    this.previousKeys = currentKeys;
    return emitted;
  }

  /** Marks the current projection as already present without replaying its backlog. */
  prime(items: readonly StatusRollupItem[]): void {
    this.previousKeys = new Set(items.map(item => item.key));
  }

  clear(): void {
    this.previousKeys.clear();
  }
}

/** Compact cursor for immutable, append-only history rows returned as complete arrays. */
export class ThreadAgentHistoryCursor {
  private highestObservedAt = Number.NEGATIVE_INFINITY;
  private keysAtHighestTimestamp = new Set<string>();

  get retainedKeyCount(): number {
    return this.keysAtHighestTimestamp.size;
  }

  /** Emits only new append-only rows, retaining ties at the current source timestamp. */
  select(items: readonly StatusRollupItem[]): StatusRollupItem[] {
    const selected: StatusRollupItem[] = [];
    const ordered = [...items].sort((left, right) => left.observedAt - right.observedAt);
    for (const item of ordered) {
      if (!Number.isFinite(item.observedAt)) continue;
      if (item.observedAt < this.highestObservedAt) continue;
      if (item.observedAt > this.highestObservedAt) {
        this.highestObservedAt = item.observedAt;
        this.keysAtHighestTimestamp.clear();
      }
      if (this.keysAtHighestTimestamp.has(item.key)) {
        continue;
      }
      this.keysAtHighestTimestamp.add(item.key);
      selected.push(item);
    }
    return selected;
  }

  /** Seeds the cursor when old projected history should not be replayed. */
  prime(items: readonly StatusRollupItem[]): void {
    const ordered = [...items].sort((left, right) => left.observedAt - right.observedAt);
    for (const item of ordered) {
      if (!Number.isFinite(item.observedAt) || item.observedAt < this.highestObservedAt) continue;
      if (item.observedAt > this.highestObservedAt) {
        this.highestObservedAt = item.observedAt;
        this.keysAtHighestTimestamp.clear();
      }
      this.keysAtHighestTimestamp.add(item.key);
    }
  }

  clear(): void {
    this.highestObservedAt = Number.NEGATIVE_INFINITY;
    this.keysAtHighestTimestamp.clear();
  }
}

/** Holds only events awaiting transfer to the status queue. */
export class ThreadAgentEventBuffer {
  readonly items = ref<StatusRollupItem[]>([]);

  /** Retains one newest event while the status-line consumer is absent. */
  appendNewest(item: StatusRollupItem): void {
    const existing = this.items.value[0];
    if (existing?.key === item.key && existing.kind === 'thought' && item.kind === 'thought' && existing.text !== item.text) {
      this.items.value = [existing.updateOnly ? item : { ...item, updateOnly: false }];
      return;
    }
    if (existing && item.observedAt < existing.observedAt) return;
    this.items.value = [item.updateOnly ? { ...item, updateOnly: false } : item];
  }

  /** Keeps only the most recent pending event when the consumer detaches. */
  retainNewest(): void {
    const newest = this.items.value[this.items.value.length - 1];
    this.items.value = newest ? [newest.updateOnly ? { ...newest, updateOnly: false } : newest] : [];
  }

  append(item: StatusRollupItem): void {
    const index = this.items.value.findIndex(existing => existing.key === item.key);
    if (index >= 0) {
      const existing = this.items.value[index];
      if (item.kind === 'thought' && existing?.kind === 'thought' && existing.text !== item.text) {
        const updated = [...this.items.value];
        updated[index] = existing.updateOnly ? item : { ...item, updateOnly: false };
        this.items.value = updated;
      }
      return;
    }

    const ordered = [...this.items.value];
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ordered[middle]!.observedAt <= item.observedAt) low = middle + 1;
      else high = middle;
    }
    ordered.splice(low, 0, item);
    this.items.value = ordered;
  }

  consume(): void {
    this.items.value = [];
  }

  clear(): void {
    this.consume();
  }
}
