// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { nextTick, ref } from 'vue';

import { FilesDropTargets } from './FilesDropTargets';
import { FilesNameRules } from './FilesNameRules';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry } from './FilesBrowserTypes';

/** Inline rename of one row (Enter on macOS, F2 elsewhere), committed as a durable move. */
export class FilesBrowserRename {
  readonly editingKey = ref('');
  readonly renameValue = ref('');
  private renameCommitting = false;

  constructor(private readonly browser:FilesBrowserController) {}

  readonly beginRename = (entry = this.browser.selection.selectedEntries.value[0]):void => {
    const state = this.browser.state;

    if (this.browser.location.readOnlyArea.value) return;
    if (state.busy.value || state.section.value === 'trash' || !entry || this.browser.selection.selectedEntries.value.length > 1) return;
    const index = this.browser.listing.displayedEntries.value.findIndex(item => item.key === entry.key);

    if (index >= 0) this.browser.virtualScroll.scrollEntryIntoView(index);
    this.editingKey.value = entry.key; this.renameValue.value = entry.name;
    void nextTick(() => this.setRenameInput(state.browserSurface.value?.querySelector<HTMLInputElement>('.inline-rename'), entry));
  };

  /** Function ref of the inline input: focus it once and pre-select the name without its extension. */
  readonly setRenameInput = (element:unknown, entry:DisplayEntry):void => {
    if (!(element instanceof HTMLInputElement) || this.editingKey.value !== entry.key || document.activeElement === element) return;
    void nextTick(() => { if (!element.isConnected || this.editingKey.value !== entry.key) return; element.focus(); element.setSelectionRange(0, FilesNameRules.renameSelectionEnd(entry.name, entry.folder)) });
  };

  readonly cancelRename = ():void => { const key = this.editingKey.value; this.editingKey.value = ''; this.renameValue.value = ''; this.renameCommitting = false; if (key) void nextTick(() => { if (!this.editingKey.value) this.browser.state.browserSurface.value?.querySelector<HTMLElement>(`[data-entry-key="${ CSS.escape(key) }"]`)?.focus() }) };

  readonly commitRename = async(entry:DisplayEntry):Promise<void> => {
    if (this.renameCommitting || this.editingKey.value !== entry.key) return;
    const decision = FilesNameRules.decideRename(entry.name, this.renameValue.value);

    if (decision.kind === 'cancel') { this.cancelRename(); return }
    if (decision.kind === 'invalid') { this.browser.state.operationError.value = decision.message; return }
    this.renameCommitting = true; const parent = entry.path.split('/').slice(0, -1).join('/'); const success = await this.browser.fileOperations.perform('move', [{ ...FilesDropTargets.operationTarget(FilesDropTargets.toTarget(entry), parent), targetPath: FilesDropTargets.joinPath(parent, decision.name) }]);

    if (success) this.cancelRename(); else this.renameCommitting = false;
  };

  readonly renameSelected = ():void => { const selected = this.browser.selection.selectedEntries.value; const entry = selected[0]; if (entry && selected.length === 1) this.beginRename(entry) };
}
