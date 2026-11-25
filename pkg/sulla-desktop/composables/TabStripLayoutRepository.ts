// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { shallowRef, type ShallowRef } from 'vue';

import type { TabGroupId } from './TabGroupModel';

export type TabStripStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Persists folded group IDs under the caller's existing per-window storage key. */
export class TabStripLayoutRepository {
  private static readonly stateByStorage = new WeakMap<object, Map<string, ShallowRef<TabGroupId[]>>>();
  private readonly groupIds: readonly TabGroupId[] = ['chats', 'browser', 'tools'];
  readonly foldedGroups:     ShallowRef<TabGroupId[]>;

  constructor(private readonly storage: TabStripStorage, private readonly key: string) {
    let byKey = TabStripLayoutRepository.stateByStorage.get(storage as object);
    if (!byKey) {
      byKey = new Map();
      TabStripLayoutRepository.stateByStorage.set(storage as object, byKey);
    }
    let state = byKey.get(key);
    if (!state) {
      state = shallowRef(this.loadFoldedGroups());
      byKey.set(key, state);
    }
    this.foldedGroups = state;
  }

  loadFoldedGroups(): TabGroupId[] {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return ['tools'];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return ['tools'];
      return this.validGroupIds(parsed);
    } catch {
      return ['tools'];
    }
  }

  saveFoldedGroups(groupIds: readonly string[]): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.validGroupIds(groupIds)));
    } catch { /* storage can be unavailable in a hosted renderer */ }
  }

  setFoldedGroups(groupIds: readonly string[]): void {
    const valid = this.validGroupIds(groupIds);
    this.foldedGroups.value = valid;
    this.saveFoldedGroups(valid);
  }

  private validGroupIds(values: readonly unknown[]): TabGroupId[] {
    const allowed = new Set<string>(this.groupIds);
    const seen = new Set<string>();

    return values.filter((value): value is TabGroupId => {
      if (typeof value !== 'string' || !allowed.has(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }
}
