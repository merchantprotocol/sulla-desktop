// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabGroupId } from './TabGroupModel';

export type TabStripStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Persists folded group IDs under the caller's existing per-window storage key. */
export class TabStripLayoutRepository {
  private readonly groupIds: readonly TabGroupId[] = ['chats', 'browser', 'tools'];

  constructor(private readonly storage: TabStripStorage, private readonly key: string) {}

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
