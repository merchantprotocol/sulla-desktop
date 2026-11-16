// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref } from 'vue';

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';

/** Debounced content search: one request per settled query, discarded if anything changed meanwhile. */
export class FilesBrowserSearch {
  static readonly DEBOUNCE_MS = 220;

  readonly searchInput = ref<HTMLInputElement | null>(null);
  private searchTimer:ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every query change, collection switch and unmount so stale results are dropped. */
  generation = 0;

  constructor(private readonly browser:FilesBrowserController) {}

  /** Watch handler for [query, section, busy]. */
  readonly onQueryChanged = ([value, requestedSection, mutating]:[string, string, boolean]):void => {
    const state = this.browser.state;
    const generation = ++this.generation;

    if (this.searchTimer) clearTimeout(this.searchTimer);
    state.searchResults.value = null;
    state.searchCoverage.value = null;
    if (mutating || !value.trim() || requestedSection === 'trash') return;
    const collectionId = state.snapshot.value?.collection.id;
    const isCurrent = () => state.mounted && !state.busy.value && collectionId === state.snapshot.value?.collection.id && generation === this.generation && state.query.value === value && state.section.value === requestedSection;

    this.searchTimer = setTimeout(async() => {
      try {
        const result = await state.props.dataSource.search(value.trim());

        if (isCurrent()) { state.searchResults.value = result.files; state.searchCoverage.value = result.coverage }
      } catch (cause) {
        // Inline, not the page-level load error: a failed search must not hide the listing or block file actions.
        if (isCurrent()) state.operationError.value = `Search failed: ${ FilesBrowserState.messageOf(cause) }`;
      }
    }, FilesBrowserSearch.DEBOUNCE_MS);
  };

  readonly focusSearch = ():void => { this.searchInput.value?.focus() };

  stop():void { if (this.searchTimer) clearTimeout(this.searchTimer) }
}
