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

export type TabGroupPresentation = 'expanded' | 'compact' | 'folded';

export interface TabStripLayoutTab {
  id:     string;
  width:  number;
  active?: boolean;
  busy?:   boolean;
}

export interface TabStripLayoutGroup {
  id:          TabGroupId;
  tabs:        readonly TabStripLayoutTab[];
  /** Width of the capsule label and its surrounding group padding. */
  baseWidth:   number;
  /** Width of the manually folded chip, including its label and status dots. */
  foldedWidth: number;
  folded?:     boolean;
}

export interface TabGroupLayoutResult {
  id:              TabGroupId;
  presentation:    TabGroupPresentation;
  width:           number;
  visibleTabIds:   string[];
  overflowCount:   number;
  tabWidths:       ReadonlyMap<string, number>;
}

export interface TabStripLayoutInput {
  groups:         readonly TabStripLayoutGroup[];
  activeGroup?:   TabGroupId;
  availableWidth: number;
  reservedWidth?: number;
  groupGap?:      number;
  tabGap?:        number;
  compactIconWidth?: number;
  overflowWidth?: number;
  maxCompactIcons?: number;
  busyMinWidth?:  number;
  idleMinWidth?:  number;
}

function expandedGroupWidth(group: TabStripLayoutGroup, widths = group.tabs.map(tab => tab.width), tabGap = 2): number {
  return group.baseWidth + widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * tabGap;
}

function compactGroupWidth(group: TabStripLayoutGroup, visibleCount: number, iconWidth: number, overflowWidth: number, tabGap: number): number {
  const overflowCount = Math.max(0, group.tabs.length - visibleCount);
  const overflowButton = overflowCount > 0 ? overflowWidth : 0;
  const gapCount = Math.max(0, visibleCount - 1) + (overflowButton > 0 ? 1 : 0);

  return group.baseWidth + visibleCount * iconWidth + overflowButton + gapCount * tabGap;
}

function minimumTabWidth(tab: TabStripLayoutTab, busyMinWidth: number, idleMinWidth: number): number {
  if (tab.active) return tab.width;
  return tab.busy ? busyMinWidth : idleMinWidth;
}

/**
 * Allocate the strip without depending on the DOM. Compact groups are budgeted
 * before the active group; if their icons overflow, each capsule keeps a +N
 * entry and receives at most the configured number of icons.
 */
export function calculateTabStripLayout(input: TabStripLayoutInput): TabGroupLayoutResult[] {
  const {
    groups,
    activeGroup,
    availableWidth,
    reservedWidth = 0,
    groupGap = 8,
    tabGap = 2,
    compactIconWidth = 24,
    overflowWidth = 22,
    maxCompactIcons = 3,
    busyMinWidth = 110,
    idleMinWidth = 36,
  } = input;
  const sectionGapWidth = Math.max(0, groups.length - 1) * groupGap;
  const groupBudget = Math.max(0, availableWidth - reservedWidth - sectionGapWidth);
  const fullWidth = groups.reduce((total, group) => total + (group.folded ? group.foldedWidth : expandedGroupWidth(group, undefined, tabGap)), 0);

  if (fullWidth <= groupBudget) {
    return groups.map(group => ({
      id: group.id,
      presentation: group.folded ? 'folded' : 'expanded',
      width: group.folded ? group.foldedWidth : expandedGroupWidth(group, undefined, tabGap),
      visibleTabIds: group.folded ? [] : group.tabs.map(tab => tab.id),
      overflowCount: 0,
      tabWidths: new Map(group.tabs.map(tab => [tab.id, tab.width])),
    }));
  }

  const expanded = groups.find(group => group.id === activeGroup && !group.folded);
  const compact = groups.filter(group => !group.folded && group !== expanded);
  const foldedWidth = groups.reduce((total, group) => total + (group.folded ? group.foldedWidth : 0), 0);
  const minimumExpandedWidth = expanded
    ? expandedGroupWidth(expanded, expanded.tabs.map(tab => minimumTabWidth(tab, busyMinWidth, idleMinWidth)), tabGap)
    : 0;
  const compactBudget = Math.max(0, groupBudget - foldedWidth - minimumExpandedWidth);
  const fullCompactWidth = compact.reduce((total, group) => total + compactGroupWidth(group, group.tabs.length, compactIconWidth, overflowWidth, tabGap), 0);
  const needsOverflowCaps = fullCompactWidth > compactBudget;
  const visibleCounts = new Map(compact.map(group => [group.id, needsOverflowCaps ? Math.min(group.tabs.length, maxCompactIcons) : group.tabs.length]));
  const widthForCompact = () => compact.reduce((total, group) => total + compactGroupWidth(group, visibleCounts.get(group.id) ?? 0, compactIconWidth, overflowWidth, tabGap), 0);

  // Reduce icons evenly by capsule until the active group has at least its tab floors.
  while (widthForCompact() > compactBudget) {
    const reducible = [...compact]
      .filter(group => (visibleCounts.get(group.id) ?? 0) > 0)
      .sort((left, right) => (visibleCounts.get(right.id) ?? 0) - (visibleCounts.get(left.id) ?? 0));
    const group = reducible[0];

    if (!group) break;
    visibleCounts.set(group.id, (visibleCounts.get(group.id) ?? 0) - 1);
  }

  const compactWidths = new Map(compact.map(group => [
    group.id,
    compactGroupWidth(group, visibleCounts.get(group.id) ?? 0, compactIconWidth, overflowWidth, tabGap),
  ]));
  const compactWidth = [...compactWidths.values()].reduce((total, width) => total + width, 0);
  const availableExpandedWidth = Math.max(0, groupBudget - foldedWidth - compactWidth);
  const results: TabGroupLayoutResult[] = [];

  for (const group of groups) {
    if (group.folded) {
      results.push({ id: group.id, presentation: 'folded', width: group.foldedWidth, visibleTabIds: [], overflowCount: 0, tabWidths: new Map() });
      continue;
    }
    if (group !== expanded) {
      const visibleCount = visibleCounts.get(group.id) ?? 0;

      results.push({
        id: group.id,
        presentation: 'compact',
        width: compactWidths.get(group.id) ?? compactGroupWidth(group, visibleCount, compactIconWidth, overflowWidth, tabGap),
        visibleTabIds: group.tabs.slice(0, visibleCount).map(tab => tab.id),
        overflowCount: group.tabs.length - visibleCount,
        tabWidths: new Map(group.tabs.slice(0, visibleCount).map(tab => [tab.id, compactIconWidth])),
      });
      continue;
    }

    const minimums = group.tabs.map(tab => minimumTabWidth(tab, busyMinWidth, idleMinWidth));
    const width = Math.min(expandedGroupWidth(group, undefined, tabGap), Math.max(group.baseWidth, availableExpandedWidth));
    const tabSpace = Math.max(0, width - group.baseWidth - Math.max(0, group.tabs.length - 1) * tabGap);
    const widths = group.tabs.map(tab => tab.width);
    let excess = Math.max(0, widths.reduce((total, tabWidth) => total + tabWidth, 0) - tabSpace);

    // Drain the widest title down to its floor before shrinking any shorter title.
    const widestFirst = group.tabs
      .map((tab, index) => ({ tab, index, width: widths[index], floor: minimums[index] }))
      .sort((left, right) => right.width - left.width);

    for (const entry of widestFirst) {
      if (excess <= 0) break;
      const reduction = Math.min(excess, Math.max(0, widths[entry.index] - entry.floor));

      widths[entry.index] -= reduction;
      excess -= reduction;
    }

    results.push({
      id: group.id,
      presentation: 'expanded',
      width,
      visibleTabIds: group.tabs.map(tab => tab.id),
      overflowCount: 0,
      tabWidths: new Map(group.tabs.map((tab, index) => [tab.id, widths[index]])),
    });
  }

  return results;
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
    return tabs.filter(tab => tab.activity === 'you').length;
  }
}
