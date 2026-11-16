// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';

export interface SavedWindowBounds { x: number; y: number; width: number; height: number; maximized?: boolean; fullScreen?: boolean }
interface Rect { x: number; y: number; width: number; height: number }

/** The window events and calls the store needs; an Electron BrowserWindow fits. */
export interface TrackedWindow {
  on(event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'enter-full-screen' | 'leave-full-screen' | 'close', listener: () => void): unknown;
  getNormalBounds(): Rect;
  isMaximized(): boolean;
  isFullScreen(): boolean;
}

/**
 * Keeps the main window where the user left it: position, size, maximized
 * and full screen, saved to a small JSON file and restored on the next open
 * when that spot is still on a connected display.
 */
export class WindowBoundsStore {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly tracked = new WeakSet<TrackedWindow>();

  constructor(private readonly file: string, private readonly saveDelayMs = 400) {}

  /** The saved bounds, if they still fit on one of `workAreas` (a display may have been unplugged). */
  restore(workAreas: readonly Rect[]): SavedWindowBounds | null {
    let saved: SavedWindowBounds;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return null }
    const sizes = [saved?.x, saved?.y, saved?.width, saved?.height];
    if (!sizes.every(Number.isFinite) || saved.width < 400 || saved.height < 300) return null;
    // Visible enough to grab: at least 100x50 of it on some display.
    const onScreen = workAreas.some(area =>
      Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x) >= 100 &&
      Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y) >= 50);
    return onScreen ? saved : null;
  }

  /** Save on every resize, move and state change (debounced), and once more on close. False when already tracked. */
  track(window: TrackedWindow): boolean {
    if (this.tracked.has(window)) return false;
    this.tracked.add(window);
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.save(window), this.saveDelayMs);
    };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) window.on(event, later);
    window.on('close', () => { clearTimeout(this.timer); this.save(window) });
    return true;
  }

  private save(window: TrackedWindow): void {
    try {
      // Normal bounds: the size to come back to when it is no longer maximized.
      const bounds: SavedWindowBounds = { ...window.getNormalBounds(), maximized: window.isMaximized(), fullScreen: window.isFullScreen() };
      fs.writeFileSync(this.file, JSON.stringify(bounds));
    } catch { /* a convenience; the window still works */ }
  }
}
