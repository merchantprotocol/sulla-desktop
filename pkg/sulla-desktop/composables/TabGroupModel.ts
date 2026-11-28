// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabStripLayoutRepository } from './TabStripLayoutRepository';

export type TabGroupId = string;

/** Theme tokens used by the group-color picker; never store literal colors. */
export const TAB_GROUP_COLOR_TOKENS = [
  'accent',
  'accent-2',
  'text-accent',
  'status-success',
  'status-warning',
  'status-error',
] as const;

export type TabGroupColorToken = typeof TAB_GROUP_COLOR_TOKENS[number];

export interface TabGroup {
  id:         TabGroupId;
  name:       string;
  colorToken: TabGroupColorToken;
  order:      number;
  collapsed:  boolean;
}

export type TabGroupBoundary = 'start' | 'end';

export interface GroupableTab {
  id:     string;
  pinned?: boolean;
}

export interface GroupedTabSection<T extends GroupableTab> {
  group: TabGroup;
  tabs:  T[];
}

export interface GroupedTabs<T extends GroupableTab> {
  pinned:    T[];
  ungrouped: T[];
  groups:    GroupedTabSection<T>[];
}

/** Owns user-defined groups and the ordering/membership invariants for one window. */
export class TabGroupModel {
  constructor(
    private readonly repository: TabStripLayoutRepository,
    private readonly generateId: () => string = () => crypto.randomUUID(),
  ) {}

  get groups(): readonly TabGroup[] {
    return this.repository.state.value.groups;
  }

  get membership(): Readonly<Record<string, TabGroupId>> {
    return this.repository.state.value.membership;
  }

  createGroup(name: string, colorToken: TabGroupColorToken, tabIds: readonly string[]): TabGroup {
    const cleanName = this.normalizeName(name);
    this.assertColorToken(colorToken);
    const initialTabIds = [...new Set(tabIds.filter(tabId => typeof tabId === 'string' && tabId.length > 0))];
    if (initialTabIds.length === 0) throw new RangeError('A group must start with at least one tab');

    const id = this.generateId();
    if (!id || this.groups.some(group => group.id === id)) throw new Error('Generated tab group id is invalid or already used');
    const group: TabGroup = {
      id,
      name: cleanName,
      colorToken,
      order: this.groups.length,
      collapsed: false,
    };
    const membership = this.copyMembership();
    for (const tabId of initialTabIds) membership[tabId] = id;
    this.commit(this.withoutEmptyGroups([...this.groups, group], membership), membership);

    return this.groups.find(candidate => candidate.id === id)!;
  }

  renameGroup(groupId: TabGroupId, name: string): boolean {
    const cleanName = this.normalizeName(name);
    const group = this.groups.find(candidate => candidate.id === groupId);
    if (!group) return false;
    if (group.name === cleanName) return true;
    this.commit(this.groups.map(candidate => candidate.id === groupId ? { ...candidate, name: cleanName } : candidate), this.copyMembership());
    return true;
  }

  setGroupColor(groupId: TabGroupId, colorToken: TabGroupColorToken): boolean {
    this.assertColorToken(colorToken);
    const group = this.groups.find(candidate => candidate.id === groupId);
    if (!group) return false;
    if (group.colorToken === colorToken) return true;
    this.commit(this.groups.map(candidate => candidate.id === groupId ? { ...candidate, colorToken } : candidate), this.copyMembership());
    return true;
  }

  setCollapsed(groupId: TabGroupId, collapsed: boolean): boolean {
    const group = this.groups.find(candidate => candidate.id === groupId);
    if (!group) return false;
    if (group.collapsed === collapsed) return true;
    this.commit(this.groups.map(candidate => candidate.id === groupId ? { ...candidate, collapsed } : candidate), this.copyMembership());
    return true;
  }

  addTabsToGroup(groupId: TabGroupId, tabIds: readonly string[]): boolean {
    if (!this.groups.some(group => group.id === groupId)) return false;
    const membership = this.copyMembership();
    for (const tabId of tabIds) if (tabId) membership[tabId] = groupId;
    this.commit(this.withoutEmptyGroups(this.groups, membership), membership);
    return true;
  }

  /** Ungroup only tabs that still belong to the supplied group. */
  removeTabsFromGroup(groupId: TabGroupId, tabIds: readonly string[]): boolean {
    const membership = this.copyMembership();
    let changed = false;
    for (const tabId of tabIds) {
      if (membership[tabId] !== groupId) continue;
      delete membership[tabId];
      changed = true;
    }
    if (changed) this.commit(this.withoutEmptyGroups(this.groups, membership), membership);
    return changed;
  }

  /** Move a tab into a group, or back to the ungrouped row when target is omitted. */
  moveTabToGroup(tabId: string, targetGroupId?: TabGroupId, preserveEmptyGroups = false): boolean {
    const currentGroupId = this.getGroupIdForTab(tabId);
    if (currentGroupId === targetGroupId) return true;
    if (!targetGroupId) {
      if (!currentGroupId) return true;
      const membership = this.copyMembership();
      delete membership[tabId];
      this.commit(preserveEmptyGroups ? this.groups : this.withoutEmptyGroups(this.groups, membership), membership);
      return true;
    }
    if (!this.groups.some(group => group.id === targetGroupId)) return false;
    const membership = this.copyMembership();
    membership[tabId] = targetGroupId;
    this.commit(preserveEmptyGroups ? this.groups : this.withoutEmptyGroups(this.groups, membership), membership);
    return true;
  }

  /** Remove a group without touching the tab store; its tabs become ungrouped. */
  deleteGroup(groupId: TabGroupId): boolean {
    if (!this.groups.some(group => group.id === groupId)) return false;
    const membership = this.copyMembership();
    for (const [tabId, assignedGroup] of Object.entries(membership)) if (assignedGroup === groupId) delete membership[tabId];
    const groups = this.groups.filter(group => group.id !== groupId).map((group, order) => ({ ...group, order }));
    this.commit(groups, membership);
    return true;
  }

  /** Move a group to an index and normalize persisted order values. */
  reorder(groupId: TabGroupId, targetOrder: number): boolean {
    const ordered = [...this.groups].sort((left, right) => left.order - right.order);
    const fromIndex = ordered.findIndex(group => group.id === groupId);
    if (fromIndex < 0) return false;
    const [group] = ordered.splice(fromIndex, 1);
    const targetIndex = Math.max(0, Math.min(Math.trunc(targetOrder), ordered.length));
    ordered.splice(targetIndex, 0, group);
    this.commit(ordered.map((entry, order) => ({ ...entry, order })), this.copyMembership());
    return true;
  }

  /** Prune stale tab IDs on startup or after a tab closes; empty groups disappear. */
  pruneTabs(validTabIds: readonly string[]): void {
    const valid = new Set(validTabIds);
    const membership = this.copyMembership();
    for (const tabId of Object.keys(membership)) if (!valid.has(tabId)) delete membership[tabId];
    const groups = this.withoutEmptyGroups(this.groups, membership);
    if (this.sameMembership(this.membership, membership) && this.sameGroups(this.groups, groups)) return;
    this.commit(groups, membership);
  }

  /** Finalize a temporary drag reassignment by removing groups left empty. */
  pruneEmptyGroups(): void {
    const groups = this.withoutEmptyGroups(this.groups, this.membership);
    if (!this.sameGroups(this.groups, groups)) this.commit(groups, this.copyMembership());
  }

  getGroupIdForTab(tabId: string): TabGroupId | undefined {
    return Object.hasOwn(this.membership, tabId) ? this.membership[tabId] : undefined;
  }

  groupTabs<T extends GroupableTab>(tabs: readonly T[]): GroupedTabs<T> {
    const ordered = this.orderTabs(tabs, tabs.map(tab => tab.id));
    const pinned = ordered.filter(tab => tab.pinned === true);
    const unpinned = ordered.filter(tab => tab.pinned !== true);
    const ungrouped = unpinned.filter(tab => !this.getGroupIdForTab(tab.id));
    const groups = [...this.groups]
      .sort((left, right) => left.order - right.order)
      .map(group => ({ group, tabs: unpinned.filter(tab => this.getGroupIdForTab(tab.id) === group.id) }))
      .filter(section => section.tabs.length > 0);

    return { pinned, ungrouped, groups };
  }

  /** Reconcile a requested order, then keep pinned, ungrouped, and group rows contiguous. */
  orderTabs<T extends GroupableTab>(tabs: readonly T[], requestedIds: readonly string[]): T[] {
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    const seen = new Set<string>();
    const requested: T[] = [];

    for (const id of requestedIds) {
      const tab = byId.get(id);
      if (tab && !seen.has(id)) {
        requested.push(tab);
        seen.add(id);
      }
    }
    for (const tab of tabs) {
      if (!seen.has(tab.id)) {
        requested.push(tab);
        seen.add(tab.id);
      }
    }

    const pinned = requested.filter(tab => tab.pinned === true);
    const unpinned = requested.filter(tab => tab.pinned !== true);
    const ungrouped = unpinned.filter(tab => !this.getGroupIdForTab(tab.id));
    const grouped = [...this.groups]
      .sort((left, right) => left.order - right.order)
      .flatMap(group => unpinned.filter(tab => this.getGroupIdForTab(tab.id) === group.id));

    return [...pinned, ...ungrouped, ...grouped];
  }

  shortcutTab<T extends GroupableTab>(orderedTabs: readonly T[], digit: string): T | undefined {
    if (!/^[1-9]$/.test(digit)) return undefined;
    return orderedTabs[digit === '9' ? orderedTabs.length - 1 : Number(digit) - 1];
  }

  orderTabIds(ids: readonly string[], pinnedIds: readonly string[]): string[] {
    const pinned = new Set(pinnedIds);
    const tabs = ids.map(id => ({ id, pinned: pinned.has(id) }));
    return this.orderTabs(tabs, ids).map(tab => tab.id);
  }

  /** Reorder tabs inside their current pinned, ungrouped, or user-group row. */
  reorderTabIds(ids: readonly string[], fromIndex: number, toIndex: number, pinnedIds: readonly string[]): string[] {
    const ordered = this.orderTabIds(ids, pinnedIds);
    if (fromIndex < 0 || fromIndex >= ordered.length || toIndex < 0 || toIndex >= ordered.length) return ordered;

    const movingId = ordered[fromIndex];
    const pinned = new Set(pinnedIds);
    const movingPinned = pinned.has(movingId);
    const movingGroup = movingPinned ? undefined : this.getGroupIdForTab(movingId);
    const inSameRow = (id: string) => movingPinned
      ? pinned.has(id)
      : !pinned.has(id) && this.getGroupIdForTab(id) === movingGroup;
    const peers = ordered.filter(inSameRow);
    const rowStart = ordered.findIndex(inSameRow);
    const target = Math.max(rowStart, Math.min(toIndex, rowStart + peers.length - 1));
    const fromPeer = peers.indexOf(movingId);

    peers.splice(fromPeer, 1);
    peers.splice(target - rowStart, 0, movingId);
    let peerIndex = 0;

    return ordered.map(id => inSameRow(id) ? peers[peerIndex++] : id);
  }

  moveToBoundary(ids: readonly string[], tabId: string, boundary: TabGroupBoundary, pinnedIds: readonly string[]): string[] {
    const ordered = this.orderTabIds(ids, pinnedIds);
    const fromIndex = ordered.indexOf(tabId);
    if (fromIndex < 0) return ordered;
    const pinned = new Set(pinnedIds);
    const isMovingPinned = pinned.has(tabId);
    const rowIds = ordered.filter(id => isMovingPinned
      ? pinned.has(id)
      : !pinned.has(id) && this.getGroupIdForTab(id) === this.getGroupIdForTab(tabId));
    const rowStart = ordered.indexOf(rowIds[0]);
    const target = boundary === 'start' ? rowStart : rowStart + rowIds.length - 1;
    return this.reorderTabIds(ordered, fromIndex, target, pinnedIds);
  }

  needsYouCount(tabs: readonly { activity?: string }[]): number {
    return tabs.filter(tab => tab.activity === 'you').length;
  }

  private normalizeName(name: string): string {
    const clean = Array.from(name.trim()).slice(0, 60).join('');
    if (!clean) throw new RangeError('Tab group name cannot be empty');
    return clean;
  }

  private assertColorToken(colorToken: string): asserts colorToken is TabGroupColorToken {
    if (!(TAB_GROUP_COLOR_TOKENS as readonly string[]).includes(colorToken)) throw new RangeError('Unsupported tab group color token');
  }

  private commit(groups: readonly TabGroup[], membership: Readonly<Record<string, TabGroupId>>): void {
    this.repository.replace({
      version: 2,
      groups: [...groups].map((group, order) => ({ ...group, order })),
      membership: Object.assign(Object.create(null), membership),
    });
  }

  private copyMembership(): Record<string, TabGroupId> {
    return Object.assign(Object.create(null), this.membership) as Record<string, TabGroupId>;
  }

  private withoutEmptyGroups(groups: readonly TabGroup[], membership: Readonly<Record<string, TabGroupId>>): TabGroup[] {
    const used = new Set(Object.values(membership));
    return [...groups].filter(group => used.has(group.id)).map((group, order) => ({ ...group, order }));
  }

  private sameMembership(left: Readonly<Record<string, TabGroupId>>, right: Readonly<Record<string, TabGroupId>>): boolean {
    const leftEntries = Object.entries(left);
    if (leftEntries.length !== Object.keys(right).length) return false;
    return leftEntries.every(([tabId, groupId]) => right[tabId] === groupId);
  }

  private sameGroups(left: readonly TabGroup[], right: readonly TabGroup[]): boolean {
    return left.length === right.length && left.every((group, index) => {
      const other = right[index];
      return group.id === other.id && group.name === other.name && group.colorToken === other.colorToken &&
        group.order === other.order && group.collapsed === other.collapsed;
    });
  }
}
