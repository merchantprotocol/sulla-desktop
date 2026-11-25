// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GroupableTab, TabGroupModel } from './TabGroupModel';
import type { TabStripLayoutRepository } from './TabStripLayoutRepository';

/** Reveals a selection once, regardless of how many headers render it. */
export class TabGroupReveal {
  constructor(
    private readonly groups: TabGroupModel,
    private readonly layout: Pick<TabStripLayoutRepository, 'foldedGroups' | 'setFoldedGroups'>,
    private activeId?: string,
  ) {}

  select(tab: GroupableTab | null): void {
    if (this.activeId === tab?.id) return;
    this.activeId = tab?.id;
    if (!tab || tab.pinned) return;
    const group = this.groups.groupForMode(tab.mode);
    const folded = this.layout.foldedGroups.value;

    if (folded.includes(group)) this.layout.setFoldedGroups(folded.filter(id => id !== group));
  }
}
