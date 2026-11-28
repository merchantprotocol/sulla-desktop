// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type TabGroupPresentation = 'expanded' | 'compact' | 'folded';

export interface TabStripLayoutTab {
  id: string;
}

export interface TabStripLayoutGroup {
  id:          string;
  tabs:        readonly TabStripLayoutTab[];
  /** Approximate user-group header and padding width. */
  baseWidth:   number;
  /** Width of the manually collapsed group header. */
  foldedWidth: number;
  folded?:     boolean;
}

export interface TabGroupLayoutResult {
  id:            string;
  presentation:  TabGroupPresentation;
  visibleTabIds: string[];
  overflowCount: number;
}

export interface TabStripLayoutInput {
  groups:            readonly TabStripLayoutGroup[];
  availableWidth:    number;
  reservedWidth?:    number;
  groupGap?:         number;
  tabGap?:           number;
  minimumTabWidth?:  number;
  compactIconWidth?: number;
  overflowWidth?:    number;
  maxCompactIcons?:  number;
}

/** Decide only which user groups need compact icons; tab widths stay with CSS flex layout. */
export class TabStripLayoutAllocator {
  constructor(private readonly input: TabStripLayoutInput) {}

  allocate(): TabGroupLayoutResult[] {
    const {
      groups,
      availableWidth,
      reservedWidth = 0,
      groupGap = 8,
      tabGap = 2,
      minimumTabWidth = 64,
      compactIconWidth = 24,
      overflowWidth = 22,
      maxCompactIcons = 3,
    } = this.input;
    const budget = Math.max(0, availableWidth - reservedWidth - Math.max(0, groups.length - 1) * groupGap);
    const visibleCounts = new Map<string, number>();
    const compactIds = new Set<string>();
    const tabGaps = (count: number) => Math.max(0, count - 1) * tabGap;
    const expandedWidth = (group: TabStripLayoutGroup) => group.baseWidth + group.tabs.length * minimumTabWidth + tabGaps(group.tabs.length);
    const compactWidth = (group: TabStripLayoutGroup, visible: number) => {
      const overflow = Math.max(0, group.tabs.length - visible);
      return group.baseWidth + visible * compactIconWidth + (overflow > 0 ? overflowWidth : 0) + tabGaps(visible + (overflow > 0 ? 1 : 0));
    };
    const currentWidth = () => groups.reduce((total, group) => {
      if (group.folded) return total + group.foldedWidth;
      if (!compactIds.has(group.id)) return total + expandedWidth(group);
      return total + compactWidth(group, visibleCounts.get(group.id) ?? Math.min(group.tabs.length, maxCompactIcons));
    }, 0);
    const build = (): TabGroupLayoutResult[] => groups.map(group => {
      if (group.folded) return { id: group.id, presentation: 'folded', visibleTabIds: [], overflowCount: 0 };
      if (!compactIds.has(group.id)) return {
        id: group.id,
        presentation: 'expanded',
        visibleTabIds: group.tabs.map(tab => tab.id),
        overflowCount: 0,
      };
      const visible = visibleCounts.get(group.id) ?? Math.min(group.tabs.length, maxCompactIcons);
      return {
        id: group.id,
        presentation: 'compact',
        visibleTabIds: group.tabs.slice(0, visible).map(tab => tab.id),
        overflowCount: group.tabs.length - visible,
      };
    });

    if (currentWidth() <= budget) return build();

    const compactable = groups.filter(group => !group.folded && group.tabs.length > 0)
      .sort((left, right) => (expandedWidth(right) - compactWidth(right, Math.min(right.tabs.length, maxCompactIcons))) -
        (expandedWidth(left) - compactWidth(left, Math.min(left.tabs.length, maxCompactIcons))));

    for (const group of compactable) {
      compactIds.add(group.id);
      visibleCounts.set(group.id, Math.min(group.tabs.length, maxCompactIcons));
      if (currentWidth() <= budget) return build();
    }

    while (currentWidth() > budget) {
      const reducible = compactable.find(group => (visibleCounts.get(group.id) ?? 0) > 0);
      if (!reducible) break;
      visibleCounts.set(reducible.id, (visibleCounts.get(reducible.id) ?? 0) - 1);
    }

    return build();
  }
}

export function calculateTabStripLayout(input: TabStripLayoutInput): TabGroupLayoutResult[] {
  return new TabStripLayoutAllocator(input).allocate();
}
