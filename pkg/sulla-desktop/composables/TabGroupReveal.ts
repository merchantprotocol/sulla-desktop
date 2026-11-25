// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GroupableTab, TabGroupId, TabGroupModel } from './TabGroupModel';
import type { TabStripLayoutRepository } from './TabStripLayoutRepository';

interface TabPlacement {
  id:     string;
  pinned: boolean;
  group:  TabGroupId;
}

/** Reveals an active placement once, regardless of how many headers render it. */
export class TabGroupReveal {
  private active?: TabPlacement;

  constructor(
    private readonly groups: TabGroupModel,
    private readonly layout: Pick<TabStripLayoutRepository, 'foldedGroups' | 'setFoldedGroups'>,
    restoredTab?: GroupableTab,
  ) {
    this.active = this.placement(restoredTab);
  }

  select(tab: GroupableTab | null): void {
    const next = this.placement(tab ?? undefined);

    if (this.active?.id === next?.id && this.active?.pinned === next?.pinned && this.active?.group === next?.group) return;
    this.active = next;
    if (!next || next.pinned) return;
    const { group } = next;
    const folded = this.layout.foldedGroups.value;

    if (folded.includes(group)) this.layout.setFoldedGroups(folded.filter(id => id !== group));
  }

  private placement(tab?: GroupableTab): TabPlacement | undefined {
    if (tab) return { id: tab.id, pinned: tab.pinned === true, group: this.groups.groupForMode(tab.mode) };
  }
}
