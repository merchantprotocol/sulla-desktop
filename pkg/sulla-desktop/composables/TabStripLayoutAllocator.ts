// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabGroupId } from './TabGroupModel';

export type TabGroupPresentation = 'expanded' | 'compact' | 'folded';

export interface TabStripLayoutTab {
  id:      string;
  width:   number;
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
  id:            TabGroupId;
  presentation:  TabGroupPresentation;
  width:         number;
  visibleTabIds: string[];
  overflowCount: number;
  tabWidths:     ReadonlyMap<string, number>;
}

export interface TabStripLayoutInput {
  groups:             readonly TabStripLayoutGroup[];
  /** Previous result, used only to keep automatic compaction stable while resizing. */
  previousLayout?:    readonly TabGroupLayoutResult[];
  activeGroup?:       TabGroupId;
  availableWidth:     number;
  reservedWidth?:     number;
  groupGap?:          number;
  tabGap?:            number;
  compactIconWidth?:  number;
  overflowWidth?:     number;
  maxCompactIcons?:   number;
  busyMinWidth?:      number;
  idleMinWidth?:      number;
  minimumTitleWidth?: number;
  compactHysteresis?: number;
}

/** Allocate a strip without the DOM; level titles before compacting groups. */
export class TabStripLayoutAllocator {
  constructor(private readonly input: TabStripLayoutInput) {}

  allocate(): TabGroupLayoutResult[] {
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
    } = this.input;
    const sectionGapWidth = Math.max(0, groups.length - 1) * groupGap;
    const groupBudget = Math.max(0, availableWidth - reservedWidth - sectionGapWidth);
    const widthsForGroup = (group: TabStripLayoutGroup) => group.tabs.map(tab => this.naturalTabWidth(tab, busyMinWidth, idleMinWidth));
    const expanded = groups.filter(group => !group.folded);
    const compactable = expanded.filter(group => group.id !== activeGroup && group.tabs.length > 0);
    const foldedWidth = groups.reduce((total, group) => total + (group.folded ? group.foldedWidth : 0), 0);
    const fullNaturalWidth = groups.reduce((total, group) => total + (group.folded
      ? group.foldedWidth
      : this.expandedGroupWidth(group, widthsForGroup(group), tabGap)), 0);
    const readableIdleFloor = Math.max(idleMinWidth, minimumTitleWidth);
    const minimumExpandedWidth = foldedWidth + expanded.reduce((total, group) => total +
      this.minimumExpandedGroupWidth(group, busyMinWidth, idleMinWidth, readableIdleFloor, tabGap), 0);
    const previousCompactIds = new Set((previousLayout ?? [])
      .filter(layout => layout.presentation === 'compact' && layout.id !== activeGroup)
      .map(layout => layout.id)
      .filter(id => compactable.some(group => group.id === id)));
    const orderedCompactable = [...compactable].sort((left, right) => {
      const widthDifference = this.expandedGroupWidth(right, widthsForGroup(right), tabGap) -
        this.expandedGroupWidth(left, widthsForGroup(left), tabGap);

      return widthDifference || groups.indexOf(left) - groups.indexOf(right);
    });

    const buildLayout = (compactIds: ReadonlySet<TabGroupId>, visibleCounts?: ReadonlyMap<TabGroupId, number>) => {
      const compactWidths = new Map<TabGroupId, number>();
      let compactWidth = 0;

      for (const group of groups) {
        if (group.folded || !compactIds.has(group.id)) continue;
        const visibleCount = visibleCounts?.get(group.id) ?? group.tabs.length;
        const width = this.compactGroupWidth(group, visibleCount, compactIconWidth, overflowWidth, tabGap);

        compactWidths.set(group.id, width);
        compactWidth += width;
      }

      const expandedRemaining = expanded.filter(group => !compactIds.has(group.id));
      const availableExpandedWidth = groupBudget - foldedWidth - compactWidth;
      const leveled = this.levelExpandedGroups(
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
            id:            group.id,
            presentation:  'compact',
            width:         compactWidths.get(group.id) ?? this.compactGroupWidth(group, visibleCount, compactIconWidth, overflowWidth, tabGap),
            visibleTabIds: group.tabs.slice(0, visibleCount).map(tab => tab.id),
            overflowCount: group.tabs.length - visibleCount,
            tabWidths:     new Map(group.tabs.slice(0, visibleCount).map(tab => [tab.id, compactIconWidth])),
          };
        }

        const widths = leveled.widthsByGroup.get(group.id) ?? [];

        return {
          id:            group.id,
          presentation:  'expanded',
          width:         this.expandedGroupWidth(group, widths, tabGap),
          visibleTabIds: group.tabs.map(tab => tab.id),
          overflowCount: 0,
          tabWidths:     new Map(group.tabs.map((tab, index) => [tab.id, widths[index]])),
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
    const keepPreviousCompaction = previousCompactIds.size > 0 &&
      groupBudget < minimumExpandedWidth + Math.max(0, compactHysteresis);

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
        .sort((left, right) => (visibleCounts.get(right.id) ?? 0) - (visibleCounts.get(left.id) ?? 0) ||
          groups.indexOf(left) - groups.indexOf(right));
      const group = reducible[0];

      if (!group) return overflowed.results;
      visibleCounts.set(group.id, (visibleCounts.get(group.id) ?? 0) - 1);
    }
  }

  private expandedGroupWidth(group: TabStripLayoutGroup, widths = group.tabs.map(tab => tab.width), tabGap = 2): number {
    return group.baseWidth + widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * tabGap;
  }

  private compactGroupWidth(group: TabStripLayoutGroup, visibleCount: number, iconWidth: number, overflowWidth: number, tabGap: number): number {
    const overflowCount = Math.max(0, group.tabs.length - visibleCount);
    const overflowButton = overflowCount > 0 ? overflowWidth : 0;
    const gapCount = Math.max(0, visibleCount - 1) + (overflowButton > 0 ? 1 : 0);

    return group.baseWidth + visibleCount * iconWidth + overflowButton + gapCount * tabGap;
  }

  private minimumTabWidth(tab: TabStripLayoutTab, busyMinWidth: number, idleMinWidth: number): number {
    if (tab.active) return tab.width;
    return tab.busy ? busyMinWidth : idleMinWidth;
  }

  private naturalTabWidth(tab: TabStripLayoutTab, busyMinWidth: number, idleMinWidth: number): number {
    return Math.max(tab.width, this.minimumTabWidth(tab, busyMinWidth, idleMinWidth));
  }

  /** Level non-active tabs to one shared cap, keeping their individual floors. */
  private levelTabWidths(
    tabs: readonly TabStripLayoutTab[],
    availableTabSpace: number,
    busyMinWidth: number,
    idleMinWidth: number,
    minimumTitleWidth: number,
  ): number[] {
    const naturalWidths = tabs.map(tab => this.naturalTabWidth(tab, busyMinWidth, idleMinWidth));
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

  private minimumExpandedGroupWidth(
    group: TabStripLayoutGroup,
    busyMinWidth: number,
    idleMinWidth: number,
    minimumTitleWidth: number,
    tabGap: number,
  ): number {
    const widths = group.tabs.map(tab => {
      const naturalWidth = this.naturalTabWidth(tab, busyMinWidth, idleMinWidth);

      if (tab.active) return naturalWidth;
      if (tab.busy) return Math.max(idleMinWidth, busyMinWidth);

      return Math.max(idleMinWidth, Math.min(naturalWidth, minimumTitleWidth));
    });

    return this.expandedGroupWidth(group, widths, tabGap);
  }

  /** Water-level all expanded groups together rather than independently by capsule. */
  private levelExpandedGroups(
    groups: readonly TabStripLayoutGroup[],
    availableWidth: number,
    busyMinWidth: number,
    idleMinWidth: number,
    minimumTitleWidth: number,
    tabGap: number,
  ): { widthsByGroup: Map<TabGroupId, number[]>; width: number; fits: boolean } {
    const fixedWidth = groups.reduce((total, group) => total + group.baseWidth +
      Math.max(0, group.tabs.length - 1) * tabGap, 0);
    const tabs = groups.flatMap(group => group.tabs);
    const widths = this.levelTabWidths(
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
}

export function calculateTabStripLayout(input: TabStripLayoutInput): TabGroupLayoutResult[] {
  return new TabStripLayoutAllocator(input).allocate();
}
