// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { nextTick } from 'vue';

import { FilesEntryKeyMap } from './FilesEntryKeyMap';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry } from './FilesBrowserTypes';

/** Keyboard handling: a focused row's shortcuts and the window-level shortcuts while the browser has focus. */
export class FilesBrowserKeyboard {
  constructor(private readonly browser:FilesBrowserController) {}

  readonly onEntryKeydown = (entry:DisplayEntry, event:KeyboardEvent):void => {
    const browser = this.browser; const state = browser.state;

    if (event.target !== event.currentTarget) return;
    event.stopPropagation();
    const action = FilesEntryKeyMap.resolve(event, { isMac: /Mac|iPhone|iPad/.test(navigator.platform), quickLookOpen: Boolean(browser.quickLook.quickLookEntry.value), canPaste: browser.fileOperations.canPaste.value, inTrash: state.section.value === 'trash' });

    if (!action) return;
    if (action === 'quick-look-keys') { this.onKeydown(event); return }
    event.preventDefault();
    const entries = browser.listing.displayedEntries.value;

    switch (action) {
    case 'ignore-repeat': return;
    case 'undo': void browser.receipts.undoLastOperation(); return;
    case 'activate': browser.navigation.activate(entry); return;
    case 'open-parent': browser.navigation.openParent(); return;
    case 'next':
    case 'previous': {
      const index = entries.findIndex(item => item.key === entry.key);
      const next = entries[Math.max(0, Math.min(entries.length - 1, index + (action === 'next' ? 1 : -1)))];

      if (next) { browser.selection.focusEntry(next, event); browser.virtualScroll.scrollEntryIntoView(entries.indexOf(next)); void nextTick(() => state.browserSurface.value?.querySelector<HTMLElement>(`[data-entry-key="${ CSS.escape(next.key) }"]`)?.focus()) }
      return;
    }
    case 'quick-look': void browser.quickLook.openQuickLook(entry); return;
    case 'rename': browser.rename.beginRename(entry); return;
    case 'select-all': browser.selection.selectOnly(entries.map(item => item.key)); return;
    case 'copy': void browser.fileOperations.copyToClipboard('copy'); return;
    case 'cut': void browser.fileOperations.copyToClipboard('cut'); return;
    case 'paste': void browser.fileOperations.pasteClipboard(); return;
    case 'trash': void browser.fileOperations.trashSelected(); return;
    case 'clear-selection': browser.selection.clearSelection(); return;
    case 'menu': void browser.menus.openActions(entry, event);
    }
  };

  /** Window keydown: only while focus is in the browser, its menus or Quick Look. */
  readonly onKeydown = (event:KeyboardEvent):void => {
    const browser = this.browser; const state = browser.state; const quickLook = browser.quickLook; const menus = browser.menus;

    if (!quickLook.quickLookDialog.value?.contains(event.target as Node) && !state.browserSurface.value?.contains(event.target as Node) && !menus.actionMenu.value?.contains(event.target as Node) && !menus.backgroundActionMenu.value?.contains(event.target as Node)) return;
    const target = event.target as HTMLElement | null; const editable = target?.matches('input,textarea,select,[contenteditable="true"]'); const modifier = event.metaKey || event.ctrlKey; const key = event.key.toLowerCase();

    if (event.key === 'Escape' && browser.dragDrop.dragging.value) { browser.dragDrop.cancelExternalDrag(); return }
    if (editable) { if (event.key === 'Escape') (target as HTMLElement).blur(); return }
    if (quickLook.quickLookEntry.value) {
      if (event.key === 'Tab') { const controls = [...(quickLook.quickLookDialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),video,audio,iframe') ?? [])]; const index = controls.indexOf(document.activeElement as HTMLElement); if (controls.length) { event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus() } } else if (event.key === 'Escape' || (event.key === ' ' && !target?.closest('button,video,audio'))) { event.preventDefault(); quickLook.closeQuickLook() } else if (!target?.closest('video,audio') && event.key === 'ArrowLeft') { event.preventDefault(); quickLook.stepQuickLook(-1) } else if (!target?.closest('video,audio') && event.key === 'ArrowRight') { event.preventDefault(); quickLook.stepQuickLook(1) }
      return;
    }
    if (event.repeat && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); return }
    if (state.selected.value || state.shareTarget.value || browser.dialogs.folderDetails.value || target?.closest('button,a,dialog')) return;
    if (event.key === 'Escape') { browser.rename.cancelRename(); menus.closeActions(false); menus.closeBackgroundActions(); browser.selection.clearSelection(); return }
    if (modifier && key === 'k') { event.preventDefault(); browser.search.focusSearch(); return }
    if (modifier && key === 'z' && !event.shiftKey) { event.preventDefault(); void browser.receipts.undoLastOperation(); return }
    if (modifier && key === 'a' && !state.selected.value) { event.preventDefault(); browser.selection.selectOnly(browser.listing.visibleEntries.value.map(entry => entry.key)); return }
    if (modifier && key === 'c' && browser.selection.selectedEntries.value.length) { event.preventDefault(); void browser.fileOperations.copyToClipboard('copy'); return }
    if (modifier && key === 'x' && browser.selection.selectedEntries.value.length) { event.preventDefault(); void browser.fileOperations.copyToClipboard('cut'); return }
    if (modifier && key === 'v' && browser.fileOperations.canPaste.value) { event.preventDefault(); void browser.fileOperations.pasteClipboard(); return }
    if (modifier && event.key === 'ArrowUp' && state.section.value === 'files') { event.preventDefault(); browser.navigation.openParent(); return }
    if ((event.key === 'Delete' || (event.metaKey && event.key === 'Backspace')) && browser.selection.selectedEntries.value.length && state.section.value !== 'trash') { event.preventDefault(); void browser.fileOperations.trashSelected(); return }
    if (event.key === ' ' && browser.selection.selectedEntries.value.some(entry => !entry.folder)) { event.preventDefault(); void browser.quickLook.openQuickLook() }
  };
}
