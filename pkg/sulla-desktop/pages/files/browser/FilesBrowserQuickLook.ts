// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, nextTick, ref } from 'vue';

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry } from './FilesBrowserTypes';

/** Space-bar Quick Look: a modal preview of one file that steps through the visible files. */
export class FilesBrowserQuickLook {
  readonly quickLookEntry = ref<DisplayEntry | null>(null);
  readonly quickLookUrl = ref('');
  readonly quickLookError = ref('');
  readonly quickLookLoading = ref(false);
  readonly quickLookDialog = ref<HTMLElement | null>(null);
  readonly quickLookEntries = computed(() => this.browser.listing.visibleEntries.value.filter(entry => !entry.folder));
  readonly quickLookIndex = computed(() => this.quickLookEntry.value ? this.quickLookEntries.value.findIndex(entry => entry.key === this.quickLookEntry.value?.key) : -1);
  /** Bumped by every open/close and unmount so a slow preview URL never lands on a newer item. */
  generation = 0;
  private trigger:HTMLElement | null = null;

  constructor(private readonly browser:FilesBrowserController) {}

  readonly openQuickLook = async(entry = this.browser.selection.selectedEntries.value.find(item => !item.folder)):Promise<void> => {
    if (!entry || entry.folder) return;
    if (!this.quickLookEntry.value) this.trigger = document.activeElement as HTMLElement | null;
    this.quickLookEntry.value = entry; this.quickLookUrl.value = ''; this.quickLookError.value = ''; this.quickLookLoading.value = true; const generation = ++this.generation;

    await nextTick(); if (generation !== this.generation) return; this.quickLookDialog.value?.querySelector<HTMLButtonElement>('button')?.focus();
    try { const url = await this.browser.state.props.dataSource.mediaUrl(entry.id, entry.currentVersionId); if (generation === this.generation) this.quickLookUrl.value = url } catch (cause) { if (generation === this.generation) { this.quickLookUrl.value = ''; this.quickLookError.value = FilesBrowserState.messageOf(cause) } } finally { if (generation === this.generation) this.quickLookLoading.value = false }
  };

  readonly closeQuickLook = ():void => { const wasOpen = Boolean(this.quickLookEntry.value); this.generation++; this.quickLookEntry.value = null; this.quickLookUrl.value = ''; this.quickLookLoading.value = false; if (wasOpen) this.trigger?.focus(); this.trigger = null };

  readonly stepQuickLook = (delta:number):void => { const entry = this.quickLookEntries.value[this.quickLookIndex.value + delta]; if (entry) void this.openQuickLook(entry) };

  readonly openQuickLookSelection = ():void => { const entry = this.quickLookEntry.value; if (!entry) return; this.closeQuickLook(); this.browser.navigation.openDisplayEntry(entry) };
}
