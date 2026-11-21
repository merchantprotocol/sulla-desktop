// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { nextTick, onBeforeUnmount, onMounted, triggerRef, watch } from 'vue';

import type { FilesBrowserController } from './FilesBrowserController';

/**
 * Wires one browser into Vue: its watchers (in the order they have always been registered, which decides the
 * order they run in on a shared change), the mount-time listeners and subscriptions, and their removal.
 */
export class FilesBrowserLifecycle {
  private stopFilesChanged:(() => void) | undefined;
  private stopFolderFilesChanged:(() => void) | undefined;
  private stopCapabilitiesChanged:(() => void) | undefined;
  private stopUploadProgress:(() => void) | undefined;

  constructor(private readonly browser:FilesBrowserController) {}

  /** Register watchers and lifecycle hooks. Call once, during the component's setup. */
  bind():void {
    const b = this.browser; const state = b.state;

    watch(b.preferences.view, async(view) => {
      b.gestures.stopPointerGesture?.();
      b.virtualScroll.virtualScrollTop.value = 0;
      if (view === 'grid' && state.mainSurface.value) state.mainSurface.value.scrollTop = 0;
      b.preferences.saveFolderPreferences();
      await nextTick();
      b.virtualScroll.observeGrid();
    });
    watch([state.section, state.currentPath, state.query], () => b.virtualScroll.resetScroll());
    watch([state.mainSurface, b.virtualScroll.listSurface], ([page, list], _previous, onCleanup) => {
      if (!page || !list) return;
      onCleanup(b.virtualScroll.bindListPage());
    }, { flush: 'post' });
    watch([() => state.props.dataSource, () => state.snapshot.value?.collection.id, state.section, state.currentPath, state.query, state.busy], b.dragSnapshots.invalidate, { flush: 'sync' });
    watch([state.selectedKeys, b.listing.visibleEntries], b.dragSnapshots.revalidate, { flush: 'sync' });
    onBeforeUnmount(b.dragSnapshots.invalidate);
    watch([state.query, state.section, state.busy], b.search.onQueryChanged);
    watch(state.busy, value => { if (!value) b.navigation.consumeNavigation() });
    watch(() => state.props.navigation, () => b.navigation.consumeNavigation());
    watch([state.busy, state.loading], ([mutating, fetching]) => { if (!mutating && !fetching && b.liveUpdates.pendingChange) b.liveUpdates.scheduleFilesRefresh() });
    watch(state.currentPath, b.folderLoader.loadFolder);
    watch([state.section, state.refreshCount, state.starred], () => { void b.folderLoader.loadSectionFiles() });
    watch([state.section, state.currentPath, state.refreshCount, state.expandedFolders, state.starred], () => { void b.folderLoader.loadFolderSummaries() });
    watch(state.expandedFolders, () => { void b.folderLoader.loadExpandedFolders(false) });
    watch(state.refreshCount, () => { void b.folderLoader.loadExpandedFolders(true) });
    watch(() => state.snapshot.value?.collection.id, () => b.listing.resetForCollection());
    onMounted(() => this.mount());
    onBeforeUnmount(() => this.unmount());
  }

  private async mount():Promise<void> {
    const b = this.browser; const state = b.state; const source = state.props.dataSource;

    state.mounted = true; this.stopFilesChanged = source.onFilesChanged?.(b.liveUpdates.onFilesChanged); this.stopFolderFilesChanged = source.onFolderFilesChanged?.(files => { if (state.section.value === 'files' && state.snapshot.value) state.snapshot.value = { ...state.snapshot.value, files } });
    window.addEventListener('focus', b.liveUpdates.refreshVisibleFiles); document.addEventListener('visibilitychange', b.liveUpdates.refreshVisibleFiles);
    b.virtualScroll.gridResizeObserver = new ResizeObserver(b.virtualScroll.updateGridColumns); await nextTick(); if (b.virtualScroll.gridSurface.value) b.virtualScroll.gridResizeObserver.observe(b.virtualScroll.gridSurface.value);
    window.addEventListener('click', b.gestures.captureGestureClick, true); window.addEventListener('keydown', b.keyboard.onKeydown); window.addEventListener('pointerdown', b.menus.dismissActions); window.addEventListener('resize', b.menus.closeMenuOnResize); window.addEventListener('dragover', b.dragDrop.updateDragPointer);
    this.stopCapabilitiesChanged = state.props.dataSource.onCapabilitiesChanged?.(() => triggerRef(state.snapshot));
    this.stopUploadProgress = state.props.dataSource.onUploadProgress?.(b.uploads.onUploadProgress);
    await b.refresher.refresh(); if (!state.mounted) return; b.explorer.clearForCollection(state.snapshot.value?.collection.id ?? ''); b.preferences.loadFolderPreferences(); b.navigation.consumeNavigation(); b.liveUpdates.startPolling();
  }

  private unmount():void {
    const b = this.browser; const state = b.state;

    state.mounted = false; this.stopFilesChanged?.(); this.stopFolderFilesChanged?.(); b.liveUpdates.stopTimers();
    window.removeEventListener('focus', b.liveUpdates.refreshVisibleFiles); document.removeEventListener('visibilitychange', b.liveUpdates.refreshVisibleFiles); b.virtualScroll.gridResizeObserver?.disconnect();
    state.refreshGeneration++; b.search.generation++; b.quickLook.generation++; b.gestures.stopPointerGesture?.(); b.dragDrop.cancelHoverOpen();
    b.search.stop(); b.gestures.clearClickTimer(); b.uploads.stop();
    window.removeEventListener('click', b.gestures.captureGestureClick, true); window.removeEventListener('keydown', b.keyboard.onKeydown); window.removeEventListener('pointerdown', b.menus.dismissActions); window.removeEventListener('resize', b.menus.closeMenuOnResize); window.removeEventListener('dragover', b.dragDrop.updateDragPointer);
    this.stopCapabilitiesChanged?.(); this.stopUploadProgress?.(); b.liveUpdates.stopPolling();
  }
}
