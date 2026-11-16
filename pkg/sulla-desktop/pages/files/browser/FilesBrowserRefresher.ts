// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';

/** Loads the collection snapshot and runs every mutation with the busy/reload discipline. */
export class FilesBrowserRefresher {
  constructor(private readonly browser:FilesBrowserController) {}

  readonly refresh = async(silent = false, afterMutation = false):Promise<void> => {
    const state = this.browser.state;

    if (state.busy.value && !afterMutation) return;
    const generation = ++state.refreshGeneration; const source = state.props.dataSource;
    const isCurrent = () => state.mounted && generation === state.refreshGeneration && source === state.props.dataSource;

    if (!silent) state.loading.value = true;
    try {
      const loaded = await source.load();

      if (!isCurrent()) return;
      const [stars, sources] = await Promise.all([source.listStars(loaded.collection.id), source.listNativeSources?.() ?? Promise.resolve([])]);

      if (!isCurrent()) return;
      state.nativeSources.value = sources; state.snapshot.value = loaded; state.starred.value = new Set(stars.map(star => star.fileId ?? `folder:${ star.folderPath }`)); state.error.value = ''; state.refreshCount.value++;
      await this.browser.operations.restore(loaded.collection.id);
      if (!isCurrent()) return;
      state.selectedKeys.value = new Set([...state.selectedKeys.value].filter(key => this.browser.listing.displayedEntryKeys.value.has(key)));
    } catch (cause) { if (isCurrent()) state.error.value = FilesBrowserState.messageOf(cause) } finally { if (isCurrent()) state.loading.value = false }
  };

  /** Run one mutation: refuses while busy/loading/errored, reports its error inline and reloads afterwards. */
  readonly runMutation = async(operation:() => Promise<void>, reload = true):Promise<boolean> => {
    const state = this.browser.state;

    if (state.busy.value || state.loading.value || state.error.value || !state.snapshot.value) return false;
    state.busy.value = true; state.refreshGeneration++; state.operationError.value = ''; this.browser.gestures.stopPointerGesture?.();
    try { await operation(); return true } catch (cause) { if (state.mounted) state.operationError.value = FilesBrowserState.messageOf(cause); return false } finally { if (reload && state.mounted) await this.refresh(true, true); state.busy.value = false }
  };
}
