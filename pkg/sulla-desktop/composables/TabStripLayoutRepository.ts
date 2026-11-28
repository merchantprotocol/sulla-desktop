// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { shallowRef, type ShallowRef } from 'vue';

import { TAB_GROUP_COLOR_TOKENS, type TabGroup, type TabGroupColorToken, type TabGroupId } from './TabGroupModel';

export type TabStripStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface TabStripLayoutSnapshot {
  version:    2;
  groups:     TabGroup[];
  membership: Record<string, TabGroupId>;
}

const EMPTY_SNAPSHOT: TabStripLayoutSnapshot = { version: 2, groups: [], membership: {} };

/** Persists the user-defined tab-group layout under the caller's per-window key. */
export class TabStripLayoutRepository {
  private static readonly stateByStorage = new WeakMap<object, Map<string, ShallowRef<TabStripLayoutSnapshot>>>();
  readonly state: ShallowRef<TabStripLayoutSnapshot>;

  constructor(private readonly storage: TabStripStorage, private readonly key: string) {
    let byKey = TabStripLayoutRepository.stateByStorage.get(storage as object);
    if (!byKey) {
      byKey = new Map();
      TabStripLayoutRepository.stateByStorage.set(storage as object, byKey);
    }
    let state = byKey.get(key);
    if (!state) {
      state = shallowRef(this.load());
      byKey.set(key, state);
    }
    this.state = state;
  }

  load(): TabStripLayoutSnapshot {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return this.emptySnapshot();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return this.emptySnapshot();
      const record = parsed as Record<string, unknown>;
      if (record.version !== 2) return this.emptySnapshot();
      return this.validate(record);
    } catch {
      return this.emptySnapshot();
    }
  }

  replace(snapshot: TabStripLayoutSnapshot): void {
    const valid = this.validate(snapshot as unknown as Record<string, unknown>, false);
    this.state.value = valid;
    try {
      this.storage.setItem(this.key, JSON.stringify(valid));
    } catch { /* storage can be unavailable in a hosted renderer */ }
  }

  private validate(record: Record<string, unknown>, pruneEmptyGroups = true): TabStripLayoutSnapshot {
    if (record.version !== 2 || !Array.isArray(record.groups) || !record.membership || typeof record.membership !== 'object' || Array.isArray(record.membership)) {
      return this.emptySnapshot();
    }

    const allowedColors = new Set<string>(TAB_GROUP_COLOR_TOKENS);
    const seenIds = new Set<string>();
    const groups = record.groups.flatMap((value, index): TabGroup[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const group = value as Record<string, unknown>;
      const id = typeof group.id === 'string' ? group.id.trim() : '';
      const name = typeof group.name === 'string' ? Array.from(group.name.trim()).slice(0, 60).join('') : '';
      const colorToken = typeof group.colorToken === 'string' && allowedColors.has(group.colorToken)
        ? group.colorToken as TabGroupColorToken
        : undefined;
      if (!id || seenIds.has(id) || !name || !colorToken || typeof group.collapsed !== 'boolean') return [];
      seenIds.add(id);
      return [{
        id,
        name,
        colorToken,
        order: typeof group.order === 'number' && Number.isFinite(group.order) ? group.order : index,
        collapsed: group.collapsed,
      }];
    }).sort((left, right) => left.order - right.order).map((group, order) => ({ ...group, order }));

    const validGroupIds = new Set(groups.map(group => group.id));
    const membership = Object.create(null) as Record<string, TabGroupId>;
    for (const [tabId, groupId] of Object.entries(record.membership as Record<string, unknown>)) {
      if (tabId && typeof groupId === 'string' && validGroupIds.has(groupId)) membership[tabId] = groupId;
    }

    const occupied = new Set(Object.values(membership));
    const validGroups = pruneEmptyGroups ? groups.filter(group => occupied.has(group.id)) : groups;
    const activeGroupIds = new Set(validGroups.map(group => group.id));
    for (const tabId of Object.keys(membership)) if (!activeGroupIds.has(membership[tabId])) delete membership[tabId];

    return { version: 2, groups: validGroups.map((group, order) => ({ ...group, order })), membership };
  }

  private emptySnapshot(): TabStripLayoutSnapshot {
    return { ...EMPTY_SNAPSHOT, groups: [], membership: {} };
  }
}
