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
  /** Previous result, used only to keep automatic compaction stable while resizing. */
  previousLayout?: readonly TabGroupLayoutResult[];
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
  minimumTitleWidth?: number;
  compactHysteresis?: number;
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

function naturalTabWidth(tab: TabStripLayoutTab, busyMinWidth: number, idleMinWidth: number): number {
  return Math.max(tab.width, minimumTabWidth(tab, busyMinWidth, idleMinWidth));
}

/** Level non-active tabs to one shared cap, keeping their individual floors. */
function levelTabWidths(
  tabs: readonly TabStripLayoutTab[],
  availableTabSpace: number,
  busyMinWidth: number,
  idleMinWidth: number,
  minimumTitleWidth: number,
): number[] {
  const naturalWidths = tabs.map(tab => naturalTabWidth(tab, busyMinWidth, idleMinWidth));
  const minimums = tabs.map((tab, index) => {
    if (tab.active) return naturalWidths[index];
    if (tab.busy) return Math.max(idleMinWidth, busyMinWidth);

    // A readable title width is a cap floor, not a reason to stretch a short title.
    return Math.max(idleMinWidth, Math.min(naturalWidths[index], minimumTitleWidth));
  });
  const activeWidth = tabs.reduce((total, tab, index) => total + (tab.active ? naturalWidths[index] : 0), 0);
  const adjustable = tabs.flatMap((tab, index) => tab.active ? [] : [index]);
  const adjustableSpace = availableTabSpace - activeWidth;
  const minimumTotal = adjustable.reduce((total, index) => total + minimums[index], 0);

  if (naturalWidths.reduce((total, width) => total + width, 0) <= availableTabSpace) return naturalWidths;
  if (adjustableSpace <= minimumTotal) {
    return tabs.map((tab, index) => tab.active ? naturalWidths[index] : minimums[index]);
  }

  let lowerCap = 0;
  let upperCap = Math.max(0, ...adjustable.map(index => naturalWidths[index]));

  // Find the highest uniform cap that fits; shorter titles therefore remain
  // whole whenever any longer title is still above the cap.
  for (let iteration = 0; iteration < 48; iteration++) {
    const cap = (lowerCap + upperCap) / 2;
    const total = adjustable.reduce((sum, index) => sum + Math.max(minimums[index], Math.min(naturalWidths[index], cap)), 0);

    if (total > adjustableSpace) upperCap = cap;
    else lowerCap = cap;
  }

  return tabs.map((tab, index) => tab.active
    ? naturalWidths[index]
    : Math.max(minimums[index], Math.min(naturalWidths[index], lowerCap)));
}

function minimumExpandedGroupWidth(
  group: TabStripLayoutGroup,
  busyMinWidth: number,
  idleMinWidth: number,
  minimumTitleWidth: number,
  tabGap: number,
): number {
  const widths = group.tabs.map(tab => {
    const naturalWidth = naturalTabWidth(tab, busyMinWidth, idleMinWidth);

    if (tab.active) return naturalWidth;
    if (tab.busy) return Math.max(idleMinWidth, busyMinWidth);

    return Math.max(idleMinWidth, Math.min(naturalWidth, minimumTitleWidth));
  });

  return expandedGroupWidth(group, widths, tabGap);
}

/** Water-level all expanded groups together rather than independently by capsule. */
function levelExpandedGroups(
  groups: readonly TabStripLayoutGroup[],
  availableWidth: number,
  busyMinWidth: number,
  idleMinWidth: number,
  minimumTitleWidth: number,
  tabGap: number,
): { widthsByGroup: Map<TabGroupId, number[]>; width: number; fits: boolean } {
  const fixedWidth = groups.reduce((total, group) => total + group.baseWidth
    + Math.max(0, group.tabs.length - 1) * tabGap, 0);
  const tabs = groups.flatMap(group => group.tabs);
  const widths = levelTabWidths(
    tabs,
    Math.max(0, availableWidth - fixedWidth),
    busyMinWidth,
    idleMinWidth,
    minimumTitleWidth,
  );
  const widthsByGroup = new Map<TabGroupId, number[]>();
  let tabIndex = 0;

  for (const group of groups) {
    widthsByGroup.set(group.id, widths.slice(tabIndex, tabIndex + group.tabs.length));
    tabIndex += group.tabs.length;
  }

  const width = fixedWidth + widths.reduce((total, value) => total + value, 0);

  return { widthsByGroup, width, fits: width <= availableWidth + 0.01 };
}

/** Allocate the strip without depending on the DOM; title leveling precedes compaction. */
export function calculateTabStripLayout(input: TabStripLayoutInput): TabGroupLayoutResult[] {
  const {
    groups,
    previousLayout,
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
    minimumTitleWidth = 140,
    compactHysteresis = 24,
  } = input;
  const sectionGapWidth = Math.max(0, groups.length - 1) * groupGap;
  const groupBudget = Math.max(0, availableWidth - reservedWidth - sectionGapWidth);
  const widthsForGroup = (group: TabStripLayoutGroup) => group.tabs.map(tab => naturalTabWidth(tab, busyMinWidth, idleMinWidth));
  const expanded = groups.filter(group => !group.folded);
  const compactable = expanded.filter(group => group.id !== activeGroup && group.tabs.length > 0);
  const foldedWidth = groups.reduce((total, group) => total + (group.folded ? group.foldedWidth : 0), 0);
  const fullNaturalWidth = groups.reduce((total, group) => total + (group.folded
    ? group.foldedWidth
    : expandedGroupWidth(group, widthsForGroup(group), tabGap)), 0);
  const readableIdleFloor = Math.max(idleMinWidth, minimumTitleWidth);
  const minimumExpandedWidth = foldedWidth + expanded.reduce((total, group) => total
    + minimumExpandedGroupWidth(group, busyMinWidth, idleMinWidth, readableIdleFloor, tabGap), 0);
  const previousCompactIds = new Set((previousLayout ?? [])
    .filter(layout => layout.presentation === 'compact' && layout.id !== activeGroup)
    .map(layout => layout.id)
    .filter(id => compactable.some(group => group.id === id)));
  const orderedCompactable = [...compactable].sort((left, right) => {
    const widthDifference = expandedGroupWidth(right, widthsForGroup(right), tabGap)
      - expandedGroupWidth(left, widthsForGroup(left), tabGap);

    return widthDifference || groups.indexOf(left) - groups.indexOf(right);
  });

  const buildLayout = (compactIds: ReadonlySet<TabGroupId>, visibleCounts?: ReadonlyMap<TabGroupId, number>) => {
    const compactWidths = new Map<TabGroupId, number>();
    let compactWidth = 0;

    for (const group of groups) {
      if (group.folded || !compactIds.has(group.id)) continue;
      const visibleCount = visibleCounts?.get(group.id) ?? group.tabs.length;
      const width = compactGroupWidth(group, visibleCount, compactIconWidth, overflowWidth, tabGap);

      compactWidths.set(group.id, width);
      compactWidth += width;
    }

    const expandedRemaining = expanded.filter(group => !compactIds.has(group.id));
    const availableExpandedWidth = groupBudget - foldedWidth - compactWidth;
    const leveled = levelExpandedGroups(
      expandedRemaining,
      availableExpandedWidth,
      busyMinWidth,
      idleMinWidth,
      readableIdleFloor,
      tabGap,
    );
    const results: TabGroupLayoutResult[] = groups.map(group => {
      if (group.folded) {
        return { id: group.id, presentation: 'folded', width: group.foldedWidth, visibleTabIds: [], overflowCount: 0, tabWidths: new Map() };
      }
      if (compactIds.has(group.id)) {
        const visibleCount = visibleCounts?.get(group.id) ?? group.tabs.length;

        return {
          id: group.id,
          presentation: 'compact',
          width: compactWidths.get(group.id) ?? compactGroupWidth(group, visibleCount, compactIconWidth, overflowWidth, tabGap),
          visibleTabIds: group.tabs.slice(0, visibleCount).map(tab => tab.id),
          overflowCount: group.tabs.length - visibleCount,
          tabWidths: new Map(group.tabs.slice(0, visibleCount).map(tab => [tab.id, compactIconWidth])),
        };
      }

      const widths = leveled.widthsByGroup.get(group.id) ?? [];

      return {
        id: group.id,
        presentation: 'expanded',
        width: expandedGroupWidth(group, widths, tabGap),
        visibleTabIds: group.tabs.map(tab => tab.id),
        overflowCount: 0,
        tabWidths: new Map(group.tabs.map((tab, index) => [tab.id, widths[index]])),
      };
    });

    return {
      results,
      fits: foldedWidth + compactWidth + leveled.width <= groupBudget + 0.01,
    };
  };

  // Preserve the natural layout whenever it genuinely fits. Level titles before
  // considering any automatic group compaction.
  if (fullNaturalWidth <= groupBudget) return buildLayout(new Set<TabGroupId>()).results;

  const allExpanded = buildLayout(new Set<TabGroupId>());
  const keepPreviousCompaction = previousCompactIds.size > 0
    && groupBudget < minimumExpandedWidth + Math.max(0, compactHysteresis);

  if (allExpanded.fits && !keepPreviousCompaction) return allExpanded.results;

  const compactIds = new Set<TabGroupId>();
  if (keepPreviousCompaction) {
    for (const group of orderedCompactable) {
      if (previousCompactIds.has(group.id)) compactIds.add(group.id);
    }
    const preserved = buildLayout(compactIds);

    if (preserved.fits) return preserved.results;
  }

  const compactOrder = keepPreviousCompaction
    ? [...orderedCompactable.filter(group => compactIds.has(group.id)), ...orderedCompactable.filter(group => !compactIds.has(group.id))]
    : orderedCompactable;

  for (const group of compactOrder) {
    if (compactIds.has(group.id)) continue;
    compactIds.add(group.id);
    const candidate = buildLayout(compactIds);

    if (candidate.fits) return candidate.results;
  }

  // All non-active groups are now compact; only at this point hide icons behind +N.
  const visibleCounts = new Map(orderedCompactable.map(group => [group.id, Math.min(group.tabs.length, maxCompactIcons)]));

  while (true) {
    const overflowed = buildLayout(compactIds, visibleCounts);

    if (overflowed.fits) return overflowed.results;

    const reducible = [...orderedCompactable]
      .filter(group => (visibleCounts.get(group.id) ?? 0) > 0)
      .sort((left, right) => (visibleCounts.get(right.id) ?? 0) - (visibleCounts.get(left.id) ?? 0)
        || groups.indexOf(left) - groups.indexOf(right));
    const group = reducible[0];

    if (!group) return overflowed.results;
    visibleCounts.set(group.id, (visibleCounts.get(group.id) ?? 0) - 1);
  }
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
