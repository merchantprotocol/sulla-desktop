// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GroupableTab, TabGroupId, TabGroupModel } from './TabGroupModel';

interface TabPlacement {
  id:     string;
  pinned: boolean;
  group?: TabGroupId;
}

/** Reveals a selected tab's user group once, regardless of how many headers render it. */
export class TabGroupReveal {
  private active?: TabPlacement;

  constructor(private readonly groups: Pick<TabGroupModel, 'getGroupIdForTab' | 'setCollapsed'>, restoredTab?: GroupableTab) {
    this.active = this.placement(restoredTab);
  }

  select(tab: GroupableTab | null): void {
    const next = this.placement(tab ?? undefined);

    if (this.active?.id === next?.id && this.active?.pinned === next?.pinned && this.active?.group === next?.group) return;
    this.active = next;
    if (!next || next.pinned || !next.group) return;
    this.groups.setCollapsed(next.group, false);
  }

  private placement(tab?: GroupableTab): TabPlacement | undefined {
    if (tab) return { id: tab.id, pinned: tab.pinned === true, group: this.groups.getGroupIdForTab(tab.id) };
  }
}
