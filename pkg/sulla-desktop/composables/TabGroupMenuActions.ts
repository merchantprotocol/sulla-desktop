// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabGroupColorToken, TabGroupId, TabGroupModel } from './TabGroupModel';
import type { TabGroupColorPalette } from './TabGroupColorPalette';

export interface TabGroupMenuTabAccess {
  openTabIds(): readonly string[];
  closeTabs(tabIds: readonly string[]): Promise<void>;
}

/** Applies tab/group menu choices to the group model and the window's tab store. */
export class TabGroupMenuActions {
  constructor(
    private readonly model: TabGroupModel,
    private readonly tabs: TabGroupMenuTabAccess,
    private readonly colorPalette: TabGroupColorPalette,
  ) {}

  addToNewGroup(tabId: string): TabGroupId {
    if (!tabId || !this.tabs.openTabIds().includes(tabId)) throw new RangeError('A group can only be created from an open tab');
    return this.model.createGroup('', this.colorPalette.nextToken(this.model.groups), [tabId]).id;
  }

  addToGroup(tabId: string, groupId: TabGroupId): boolean {
    if (!tabId || !groupId || !this.tabs.openTabIds().includes(tabId)) return false;
    return this.model.addTabsToGroup(groupId, [tabId]);
  }

  removeFromGroup(tabId: string): boolean {
    if (!this.tabs.openTabIds().includes(tabId)) return false;
    const groupId = this.model.membership[tabId];

    return groupId ? this.model.removeTabsFromGroup(groupId, [tabId]) : false;
  }

  renameGroup(groupId: TabGroupId, name: string): boolean {
    return this.model.renameGroup(groupId, name);
  }

  changeGroupColor(groupId: TabGroupId, colorToken: TabGroupColorToken): boolean {
    return this.model.setGroupColor(groupId, colorToken);
  }

  ungroup(groupId: TabGroupId): boolean {
    return this.model.deleteGroup(groupId);
  }

  async closeGroup(groupId: TabGroupId): Promise<readonly string[]> {
    if (!this.model.groups.some(group => group.id === groupId)) return [];
    const groupedTabIds = new Set(Object.entries(this.model.membership).filter(([, assigned]) => assigned === groupId).map(([tabId]) => tabId));
    const tabIds = this.tabs.openTabIds().filter(tabId => groupedTabIds.has(tabId));

    await this.tabs.closeTabs(tabIds);
    const openTabIds = this.tabs.openTabIds();
    const stillOpen = new Set(openTabIds);
    const closedTabIds = tabIds.filter(tabId => !stillOpen.has(tabId));

    this.model.pruneTabs(openTabIds);
    return closedTabIds;
  }
}
