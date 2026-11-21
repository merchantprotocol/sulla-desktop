// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref } from 'vue';

import { FilesBrowserVirtualScroll } from './FilesBrowserVirtualScroll';

import type { FilesBrowserController } from './FilesBrowserController';
import type { FilesMarquee } from './FilesBrowserTypes';
import type { ExplorerColumns } from '../composables/useFilesExplorerInteractions';

/** Pointer gestures on the listing: rubber-band (marquee) selection and column resizing. One at a time. */
export class FilesBrowserGestures {
  readonly marquee = ref<FilesMarquee | null>(null);
  readonly marqueeStyle = computed(() => this.marquee.value ? { left: `${ this.marquee.value.left }px`, top: `${ this.marquee.value.top }px`, width: `${ this.marquee.value.width }px`, height: `${ this.marquee.value.height }px` } : {});
  /** Ends the running gesture (as cancelled); undefined when none is running. */
  stopPointerGesture:(() => void) | undefined;
  private suppressGestureClick = false;
  private gestureClickTimer:ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly browser:FilesBrowserController) {}

  /** Window click (capture): swallow the click a finished drag gesture produces. */
  readonly captureGestureClick = (event:MouseEvent):void => {
    if (!this.suppressGestureClick) return;
    event.preventDefault(); event.stopImmediatePropagation(); this.suppressGestureClick = false;
  };

  private trackPointer(event:PointerEvent, move:(event:PointerEvent) => void, finish:(cancelled:boolean) => void, didDrag:() => boolean):void {
    const onMove = (next:PointerEvent) => { if (next.pointerId === event.pointerId) move(next) };
    const stop = (cancelled = true) => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel); window.removeEventListener('blur', onBlur);
      this.stopPointerGesture = undefined;
      if (!cancelled && didDrag()) { this.suppressGestureClick = true; if (this.gestureClickTimer) clearTimeout(this.gestureClickTimer); this.gestureClickTimer = setTimeout(() => { this.suppressGestureClick = false }, 0) }
      finish(cancelled);
    };
    const onUp = (next:PointerEvent) => { if (next.pointerId === event.pointerId) stop(false) };
    const onCancel = (next:PointerEvent) => { if (next.pointerId === event.pointerId) stop() };
    const onBlur = () => stop();

    this.stopPointerGesture = () => stop();
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onCancel); window.addEventListener('blur', onBlur);
  }

  readonly startColumnResize = (key:keyof ExplorerColumns, event:PointerEvent):void => {
    const preferences = this.browser.preferences;

    if (event.button !== 0) return;
    this.stopPointerGesture?.();
    const startX = event.clientX; const startWidth = preferences.columns.value[key];

    this.trackPointer(event, next => { preferences.columns.value = { ...preferences.columns.value, [key]: Math.max(72, Math.min(720, startWidth + next.clientX - startX)) } }, cancelled => { if (cancelled) preferences.columns.value = { ...preferences.columns.value, [key]: startWidth }; else preferences.saveFolderPreferences() }, () => true);
  };

  readonly startMarquee = (event:PointerEvent):void => {
    const state = this.browser.state; const scroll = this.browser.virtualScroll; const list = () => this.browser.preferences.view.value === 'list';

    if (event.button !== 0 || state.busy.value || (event.target as HTMLElement).closest('button,input,a,select,thead,[data-entry-key]')) return;
    this.stopPointerGesture?.(); state.mainSurface.value?.focus();
    const originX = event.clientX; const originY = event.clientY; const additive = event.metaKey || event.ctrlKey; const existing = new Set(state.selectedKeys.value);
    let moved = false;
    const move = (next:PointerEvent) => {
      if (!moved && Math.hypot(next.clientX - originX, next.clientY - originY) < 4) return;
      moved = true;
      const left = Math.min(originX, next.clientX); const top = Math.min(originY, next.clientY); const right = Math.max(originX, next.clientX); const bottom = Math.max(originY, next.clientY);

      this.marquee.value = { left, top, width: right - left, height: bottom - top, additive };
      const surface = scroll.surface();
      const surfaceRect = surface?.getBoundingClientRect();
      const listRowsTop = list() ? scroll.listRowsTop() : undefined;
      const { LIST_ROW_HEIGHT, GRID_ROW_HEIGHT } = FilesBrowserVirtualScroll;
      const hits = surface && surfaceRect ? this.browser.listing.displayedEntries.value.filter((entry, index) => {
        if (list()) {
          if (listRowsTop === undefined) return false;
          const entryTop = listRowsTop + index * LIST_ROW_HEIGHT;

          return surfaceRect.right >= left && surfaceRect.left <= right && entryTop + LIST_ROW_HEIGHT >= top && entryTop <= bottom;
        }
        const columns = scroll.gridColumns.value; const column = index % columns; const row = Math.floor(index / columns); const gap = 14;
        const width = (surface.clientWidth - gap * (columns - 1)) / columns;
        const entryLeft = surfaceRect.left + column * (width + gap);
        const entryTop = surfaceRect.top + row * GRID_ROW_HEIGHT - surface.scrollTop;

        return entryLeft + width >= left && entryLeft <= right && entryTop + GRID_ROW_HEIGHT - gap >= top && entryTop <= bottom;
      }).map(entry => entry.key) : [];

      state.selectedKeys.value = new Set([...(additive ? existing : []), ...hits]);
    };

    this.trackPointer(event, move, cancelled => { this.marquee.value = null; if (cancelled) state.selectedKeys.value = existing; else if (!moved && !additive) this.browser.selection.clearSelection() }, () => moved || additive); event.preventDefault();
  };

  /** Unmount: drop the pending click-suppression timer. */
  clearClickTimer():void { if (this.gestureClickTimer) clearTimeout(this.gestureClickTimer) }
}
