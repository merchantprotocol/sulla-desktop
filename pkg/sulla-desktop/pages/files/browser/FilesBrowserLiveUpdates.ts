// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref } from 'vue';

import type { FilesBrowserController } from './FilesBrowserController';

/** Debounced reloads after Files change events, the periodic poll and the brief "just changed" row highlight. */
export class FilesBrowserLiveUpdates {
  static readonly ACTIVITY_MS = 2400;
  static readonly CHANGE_DEBOUNCE_MS = 300;
  static readonly POLL_MS = 12_000;

  readonly activePaths = ref(new Set<string>());
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private changeTimer:ReturnType<typeof setTimeout> | undefined;
  private refreshTimer:ReturnType<typeof setInterval> | undefined;
  /** True when a change arrived that has not been reloaded yet (kept while busy or loading). */
  pendingChange = false;
  private refreshingChange = false;

  constructor(private readonly browser:FilesBrowserController) {}

  readonly scheduleFilesRefresh = ():void => {
    const state = this.browser.state;

    this.pendingChange = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(async() => {
      if (!state.mounted || state.busy.value || state.loading.value || this.refreshingChange) return;
      this.pendingChange = false;
      this.refreshingChange = true;
      try { await this.browser.refresher.refresh(true); this.browser.navigation.consumeNavigation() } finally { this.refreshingChange = false; if (state.mounted && this.pendingChange) this.scheduleFilesRefresh() }
    }, FilesBrowserLiveUpdates.CHANGE_DEBOUNCE_MS);
  };

  markActivity(paths:string[]):void {
    const touched = new Set<string>();

    // Light up the changed file and every folder above it, so changes deep in the tree are visible from here.
    for (const path of paths.slice(0, 200)) {
      const parts = path.split('/');

      for (let depth = parts.length; depth > 0; depth--) touched.add(parts.slice(0, depth).join('/'));
    }
    if (!touched.size) return;
    this.activePaths.value = new Set([...this.activePaths.value, ...touched]);
    for (const path of touched) {
      const existing = this.activityTimers.get(path);

      if (existing) clearTimeout(existing);
      this.activityTimers.set(path, setTimeout(() => {
        this.activityTimers.delete(path);
        const next = new Set(this.activePaths.value); next.delete(path); this.activePaths.value = next;
      }, FilesBrowserLiveUpdates.ACTIVITY_MS));
    }
  }

  readonly onFilesChanged = (change:{ paths:string[] }):void => { this.markActivity(change.paths); this.scheduleFilesRefresh() };

  readonly refreshVisibleFiles = ():void => { if (document.visibilityState !== 'hidden') this.scheduleFilesRefresh() };

  startPolling():void { this.refreshTimer = setInterval(this.scheduleFilesRefresh, FilesBrowserLiveUpdates.POLL_MS) }

  /** Clear the pending debounced reload and every highlight timer (first steps of unmount). */
  stopTimers():void { if (this.changeTimer) clearTimeout(this.changeTimer); this.activityTimers.forEach(clearTimeout); this.activityTimers.clear() }

  stopPolling():void { if (this.refreshTimer) clearInterval(this.refreshTimer) }
}
