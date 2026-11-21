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

  private readonly listViewportTop = ref(0);
  private readonly listViewportHeight = ref(720);

  readonly listWindow = computed(() => {
    const { LIST_ROW_HEIGHT, VIRTUAL_OVERSCAN } = FilesBrowserVirtualScroll;
    const total = this.entries.length;
    // Clamp old geometry when rows disappear before the page has adjusted its scroll position.
    const top = Math.min(this.listViewportTop.value, Math.max(0, total * LIST_ROW_HEIGHT - this.listViewportHeight.value));
    const start = Math.max(0, Math.floor(top / LIST_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
    const end = Math.max(start, Math.ceil((top + this.listViewportHeight.value) / LIST_ROW_HEIGHT) + VIRTUAL_OVERSCAN);

    return { start, end: Math.min(total, end) };
  });
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

  /** The table/section headings move with the page and are not part of its row window. */
  listRowsTop():number | undefined {
    return this.listSurface.value?.querySelector('.sechead')?.getBoundingClientRect().bottom;
  }

  readonly measureListViewport = ():void => {
    const page = this.browser.state.mainSurface.value;
    const rowsTop = this.listRowsTop();
    if (!page || rowsTop === undefined) return;

    this.listViewportTop.value = page.getBoundingClientRect().top + page.clientTop - rowsTop;
    this.listViewportHeight.value = page.clientHeight;
  };

  /** Attach only while the list and its page are both present. */
  bindListPage():() => void {
    const page = this.browser.state.mainSurface.value;
    const list = this.listSurface.value;
    if (!page || !list) return () => {};

    let previousScrollTop = page.scrollTop;
    const onScroll = () => {
      this.measureListViewport();
      if (page.scrollTop === previousScrollTop) return;
      previousScrollTop = page.scrollTop;
      if (page.scrollTop + page.clientHeight >= page.scrollHeight - 900) this.loadMore();
    };
    const resize = new ResizeObserver(this.measureListViewport);
    resize.observe(page);
    resize.observe(list);
    if (list.parentElement) resize.observe(list.parentElement);
    const header = list.querySelector('.sechead');
    if (header) resize.observe(header);
    page.addEventListener('scroll', onScroll, { passive: true });
    this.measureListViewport();

    return () => {
      page.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  }

  private loadMore():void {
    const state = this.browser.state;
    void state.props.dataSource.loadMore?.().then(files => { if (state.snapshot.value) state.snapshot.value = { ...state.snapshot.value, files: [...files] } }).catch(error => { state.operationError.value = FilesBrowserState.messageOf(error) });
  }

  readonly updateVirtualScroll = (event:Event):void => {
    const surface = event.currentTarget as HTMLElement;

    this.virtualScrollTop.value = surface.scrollTop; this.virtualViewportHeight.value = surface.clientHeight;
    if (surface.scrollTop + surface.clientHeight >= surface.scrollHeight - 900) this.loadMore();
  };

  readonly updateGridColumns = ():void => { const surface = this.gridSurface.value; if (!surface) return; this.gridColumns.value = Math.max(1, Math.floor((surface.clientWidth + 14) / (188 + 14))); this.virtualViewportHeight.value = surface.clientHeight };

  scrollEntryIntoView(index:number):void {
    if (this.browser.preferences.view.value === 'list') {
      const page = this.browser.state.mainSurface.value;
      if (!page) return;

      this.measureListViewport();
      const top = index * FilesBrowserVirtualScroll.LIST_ROW_HEIGHT;
      const bottom = top + FilesBrowserVirtualScroll.LIST_ROW_HEIGHT;
      const viewportTop = this.listViewportTop.value;
      const viewportBottom = viewportTop + this.listViewportHeight.value;
      if (top < viewportTop) page.scrollTop += top - viewportTop;
      else if (bottom > viewportBottom) page.scrollTop += bottom - viewportBottom;
      this.measureListViewport();
      return;
    }

    const surface = this.gridSurface.value; if (!surface) return;
    const row = Math.floor(index / this.gridColumns.value); const height = FilesBrowserVirtualScroll.GRID_ROW_HEIGHT; const top = row * height;

    if (top < surface.scrollTop) surface.scrollTop = top; else if (top + height > surface.scrollTop + surface.clientHeight) surface.scrollTop = top + height - surface.clientHeight;
    this.virtualScrollTop.value = surface.scrollTop;
  }

  /** A new section, folder or search starts at the top. */
  resetScroll():void {
    if (this.browser.preferences.view.value === 'list') {
      const page = this.browser.state.mainSurface.value;
      if (page) page.scrollTop = 0;
      this.measureListViewport();
      return;
    }
    this.virtualScrollTop.value = 0;
    if (this.gridSurface.value) this.gridSurface.value.scrollTop = 0;
  }

  /** Start observing the grid surface's width (on mount and whenever the grid view appears). */
  observeGrid():void { if (this.gridSurface.value) { this.gridResizeObserver?.observe(this.gridSurface.value); this.updateGridColumns() } }
}
