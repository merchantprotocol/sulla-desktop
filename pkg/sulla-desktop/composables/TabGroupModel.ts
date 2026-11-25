// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type TabGroupId = 'chats' | 'browser' | 'tools';
export type TabGroupBoundary = 'start' | 'end';

export interface GroupableTab {
  id:      string;
  mode?:   string;
  pinned?: boolean;
}

export interface TabGroup<T extends GroupableTab> {
  id:   TabGroupId;
  tabs: T[];
}

export interface GroupedTabs<T extends GroupableTab> {
  pinned: T[];
  groups: TabGroup<T>[];
}

/** Owns visual grouping and the order invariant shared by the header and tab store. */
export class TabGroupModel {
  private readonly groupOrder: readonly TabGroupId[] = ['chats', 'browser', 'tools'];

  groupForMode(mode?: string): TabGroupId {
    if (mode === 'chat' || mode === 'secretary' || mode === 'conversations') return 'chats';
    if (mode === 'browser') return 'browser';
    return 'tools';
  }

  groupTabs<T extends GroupableTab>(tabs: readonly T[]): GroupedTabs<T> {
    const pinned = tabs.filter(tab => tab.pinned === true);
    const unpinned = tabs.filter(tab => tab.pinned !== true);

    return {
      pinned,
      groups: this.groupOrder.map(id => ({
        id,
        tabs: unpinned.filter(tab => this.groupForMode(tab.mode) === id),
      })),
    };
  }

  /** Reconcile a saved order with current tabs, then enforce pinned/group order. */
  orderTabs<T extends GroupableTab>(tabs: readonly T[], requestedIds: readonly string[]): T[] {
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    const seen = new Set<string>();
    const ordered: T[] = [];

    for (const id of requestedIds) {
      const tab = byId.get(id);
      if (tab && !seen.has(id)) {
        ordered.push(tab);
        seen.add(id);
      }
    }
    for (const tab of tabs) {
      if (!seen.has(tab.id)) {
        ordered.push(tab);
        seen.add(tab.id);
      }
    }

    const grouped = this.groupTabs(ordered);

    return [...grouped.pinned, ...grouped.groups.flatMap(group => group.tabs)];
  }

  shortcutTab<T extends GroupableTab>(orderedTabs: readonly T[], digit: string): T | undefined {
    if (!/^[1-9]$/.test(digit)) return undefined;
    return orderedTabs[digit === '9' ? orderedTabs.length - 1 : Number(digit) - 1];
  }

  orderTabIds(ids: readonly string[], modes: ReadonlyMap<string, string | undefined>, pinnedIds: readonly string[]): string[] {
    const pinned = new Set(pinnedIds);
    const tabs = ids.map(id => ({ id, mode: modes.get(id), pinned: pinned.has(id) }));

    return this.orderTabs(tabs, ids).map(tab => tab.id);
  }

  /** Move by visual indices, clamping the final position to the moving tab's own group. */
  reorderTabIds(
    ids: readonly string[],
    fromIndex: number,
    toIndex: number,
    modes: ReadonlyMap<string, string | undefined>,
    pinnedIds: readonly string[],
  ): string[] {
    const ordered = this.orderTabIds(ids, modes, pinnedIds);
    if (fromIndex < 0 || fromIndex >= ordered.length || toIndex < 0 || toIndex >= ordered.length) return ordered;

    const movingId = ordered[fromIndex];
    const pinned = new Set(pinnedIds);
    const movingIsPinned = pinned.has(movingId);
    const movingGroup = this.groupForMode(modes.get(movingId));
    const isSameGroup = (id: string) => movingIsPinned
      ? pinned.has(id)
      : !pinned.has(id) && this.groupForMode(modes.get(id)) === movingGroup;
    const peers = ordered.filter(isSameGroup);
    const groupStart = ordered.findIndex(isSameGroup);
    const groupEnd = groupStart + peers.length - 1;
    const target = Math.max(groupStart, Math.min(toIndex, groupEnd));
    const fromPeer = peers.indexOf(movingId);

    peers.splice(fromPeer, 1);
    peers.splice(target - groupStart, 0, movingId);

    let peerIndex = 0;

    return ordered.map(id => isSameGroup(id) ? peers[peerIndex++] : id);
  }

  moveToBoundary(
    ids: readonly string[],
    tabId: string,
    boundary: TabGroupBoundary,
    modes: ReadonlyMap<string, string | undefined>,
    pinnedIds: readonly string[],
  ): string[] {
    const ordered = this.orderTabIds(ids, modes, pinnedIds);
    const fromIndex = ordered.indexOf(tabId);
    if (fromIndex < 0) return ordered;

    return this.reorderTabIds(ordered, fromIndex, boundary === 'start' ? 0 : ordered.length - 1, modes, pinnedIds);
  }

  needsYouCount(tabs: readonly { activity?: string }[]): number {
    return tabs.filter(tab => tab.activity === 'you' || tab.activity === 'stalled').length;
  }
}
