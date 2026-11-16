// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed } from 'vue';

import { FilesSelectionRange } from './FilesSelectionRange';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry } from './FilesBrowserTypes';

/** Which rows are selected, and the click/checkbox gestures that change it. */
export class FilesBrowserSelection {
  readonly allVisibleSelected = computed(() => { const keys = this.browser.listing.displayedEntryKeys.value; const selected = this.browser.state.selectedKeys.value; return Boolean(keys.size) && keys.size === selected.size && [...keys].every(key => selected.has(key)) });
  /** Collection rows only navigate; bulk actions never apply to them. */
  readonly selectedEntries = computed(() => [...this.browser.state.selectedKeys.value].map(key => this.browser.listing.displayedEntryMap.value.get(key)).filter((entry):entry is DisplayEntry => Boolean(entry)));
  readonly selectedFileForShare = computed(() => this.selectedEntries.value.find(entry => !entry.folder) ?? this.browser.state.selected.value);

  constructor(private readonly browser:FilesBrowserController) {}

  readonly focusEntry = (entry:DisplayEntry, event:MouseEvent | KeyboardEvent):void => {
    const state = this.browser.state;

    if (state.busy.value) return;
    this.browser.menus.closeActions(false);
    this.browser.menus.closeBackgroundActions();
    if (event instanceof MouseEvent) (event.currentTarget as HTMLElement | null)?.focus();
    if (event.shiftKey && state.selectionAnchor.value) {
      const keys = this.browser.listing.groups.value.flatMap(group => group.entries).map(item => item.key);
      const range = FilesSelectionRange.between(keys, state.selectionAnchor.value, entry.key);

      if (range) { state.selectedKeys.value = FilesSelectionRange.extend(state.selectedKeys.value, range, event.metaKey || event.ctrlKey); return }
    }
    state.selectionAnchor.value = entry.key;
    if (event.metaKey || event.ctrlKey) this.toggleSelected(entry.key); else state.selectedKeys.value = new Set([entry.key]);
  };

  readonly toggleSelected = (key:string):void => { this.browser.state.selectionAnchor.value = key; this.browser.state.selectedKeys.value = FilesSelectionRange.toggle(this.browser.state.selectedKeys.value, key) };

  readonly toggleAll = ():void => { this.browser.state.selectedKeys.value = this.allVisibleSelected.value ? new Set() : new Set(this.browser.listing.displayedEntries.value.map(entry => entry.key)) };

  readonly clearSelection = ():void => { this.browser.state.selectedKeys.value = new Set(); this.browser.state.selectionAnchor.value = null };

  /** Select exactly these keys (Cmd/Ctrl-A, the row a menu or rename acts on). */
  selectOnly(keys:Iterable<string>):void { this.browser.state.selectedKeys.value = new Set(keys) }
}
