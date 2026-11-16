// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref } from 'vue';

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';

/** Windowed rendering of the list and grid surfaces: only the rows near the viewport are mounted. */
export class FilesBrowserVirtualScroll {
  static readonly LIST_ROW_HEIGHT = 63;
  static readonly GRID_ROW_HEIGHT = 177;
  static readonly VIRTUAL_OVERSCAN = 6;

  readonly listSurface = ref<HTMLElement | null>(null);
  readonly gridSurface = ref<HTMLElement | null>(null);
  readonly virtualScrollTop = ref(0);
  readonly virtualViewportHeight = ref(720);
  readonly gridColumns = ref(1);
  gridResizeObserver:ResizeObserver | undefined;

  readonly listWindow = computed(() => { const { LIST_ROW_HEIGHT, VIRTUAL_OVERSCAN } = FilesBrowserVirtualScroll; const start = Math.max(0, Math.floor(this.virtualScrollTop.value / LIST_ROW_HEIGHT) - VIRTUAL_OVERSCAN); const count = Math.ceil(this.virtualViewportHeight.value / LIST_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2; return { start, end: Math.min(this.entries.length, start + count) } });
  readonly virtualListEntries = computed(() => this.entries.slice(this.listWindow.value.start, this.listWindow.value.end));
  readonly listTopSpacer = computed(() => this.listWindow.value.start * FilesBrowserVirtualScroll.LIST_ROW_HEIGHT);
  readonly listBottomSpacer = computed(() => Math.max(0, (this.entries.length - this.listWindow.value.end) * FilesBrowserVirtualScroll.LIST_ROW_HEIGHT));
  readonly gridWindow = computed(() => { const { GRID_ROW_HEIGHT, VIRTUAL_OVERSCAN } = FilesBrowserVirtualScroll; const rowStart = Math.max(0, Math.floor(this.virtualScrollTop.value / GRID_ROW_HEIGHT) - VIRTUAL_OVERSCAN); const visibleRows = Math.ceil(this.virtualViewportHeight.value / GRID_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2; return { start: rowStart * this.gridColumns.value, end: Math.min(this.entries.length, (rowStart + visibleRows) * this.gridColumns.value), rowStart } });
  readonly virtualGridEntries = computed(() => this.entries.slice(this.gridWindow.value.start, this.gridWindow.value.end));
  readonly gridTopSpacer = computed(() => Math.max(0, this.gridWindow.value.rowStart * FilesBrowserVirtualScroll.GRID_ROW_HEIGHT - 14));
  readonly gridBottomSpacer = computed(() => Math.max(0, (Math.ceil(this.entries.length / this.gridColumns.value) - Math.ceil(this.gridWindow.value.end / this.gridColumns.value)) * FilesBrowserVirtualScroll.GRID_ROW_HEIGHT));

  constructor(private readonly browser:FilesBrowserController) {}

  private get entries() { return this.browser.listing.displayedEntries.value }

  /** The surface the current view renders into. */
  surface():HTMLElement | null { return this.browser.preferences.view.value === 'list' ? this.listSurface.value : this.gridSurface.value }

  readonly updateVirtualScroll = (event:Event):void => {
    const state = this.browser.state; const surface = event.currentTarget as HTMLElement;

    this.virtualScrollTop.value = surface.scrollTop; this.virtualViewportHeight.value = surface.clientHeight;
    if (surface.scrollTop + surface.clientHeight >= surface.scrollHeight - 900) void state.props.dataSource.loadMore?.().then(files => { if (state.snapshot.value) state.snapshot.value = { ...state.snapshot.value, files: [...files] } }).catch(error => { state.operationError.value = FilesBrowserState.messageOf(error) });
  };

  readonly updateGridColumns = ():void => { const surface = this.gridSurface.value; if (!surface) return; this.gridColumns.value = Math.max(1, Math.floor((surface.clientWidth + 14) / (188 + 14))); this.virtualViewportHeight.value = surface.clientHeight };

  scrollEntryIntoView(index:number):void {
    const list = this.browser.preferences.view.value === 'list'; const surface = this.surface(); if (!surface) return;
    const row = list ? index : Math.floor(index / this.gridColumns.value); const height = list ? FilesBrowserVirtualScroll.LIST_ROW_HEIGHT : FilesBrowserVirtualScroll.GRID_ROW_HEIGHT; const top = row * height;

    if (top < surface.scrollTop) surface.scrollTop = top; else if (top + height > surface.scrollTop + surface.clientHeight) surface.scrollTop = top + height - surface.clientHeight;
    this.virtualScrollTop.value = surface.scrollTop;
  }

  /** A new section, folder or search starts at the top. */
  resetScroll():void { this.virtualScrollTop.value = 0; const surface = this.surface(); if (surface) surface.scrollTop = 0 }

  /** Start observing the grid surface's width (on mount and whenever the grid view appears). */
  observeGrid():void { if (this.gridSurface.value) { this.gridResizeObserver?.observe(this.gridSurface.value); this.updateGridColumns() } }
}
