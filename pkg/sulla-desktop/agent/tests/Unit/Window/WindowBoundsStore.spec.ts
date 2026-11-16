// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowBoundsStore, type TrackedWindow } from '@pkg/window/WindowBoundsStore';

const display = { x: 0, y: 25, width: 1728, height: 1092 };
let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-')); file = path.join(dir, 'b.json') });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }) });

function fakeWindow(bounds = { x: 0, y: 25, width: 1728, height: 1092 }, maximized = false) {
  const handlers: Record<string, (() => void)[]> = {};
  const win: TrackedWindow & { fire(e: string): void; bounds: typeof bounds; maximized: boolean } = {
    bounds,
    maximized,
    on(event, listener) { (handlers[event] ??= []).push(listener); return win },
    getNormalBounds: () => win.bounds,
    isMaximized:     () => win.maximized,
    isFullScreen:    () => false,
    fire(e) { for (const h of handlers[e] ?? []) h(); },
  };
  return win;
}

describe('the main window keeps its size', () => {
  // risk: every launch reset the window to 90% width and it had to be dragged to fill the screen again
  it('comes back where it was left, size and maximized state included', () => {
    vi.useFakeTimers();
    const store = new WindowBoundsStore(file, 100);
    const win = fakeWindow();
    store.track(win);
    win.bounds = { x: 0, y: 25, width: 1728, height: 1092 };
    win.maximized = true;
    win.fire('maximize');
    vi.advanceTimersByTime(150);
    expect(new WindowBoundsStore(file).restore([display])).toEqual({ x: 0, y: 25, width: 1728, height: 1092, maximized: true, fullScreen: false });
  });

  it('saves on close even without waiting', () => {
    const store = new WindowBoundsStore(file, 10_000);
    const win = fakeWindow({ x: 100, y: 80, width: 1400, height: 900 });
    store.track(win);
    win.fire('resize');
    win.fire('close');
    expect(store.restore([display])).toMatchObject({ x: 100, y: 80, width: 1400, height: 900 });
  });

  it('ignores a spot that is no longer on any display, or a broken file', () => {
    fs.writeFileSync(file, JSON.stringify({ x: 4000, y: 100, width: 1200, height: 800 }));
    expect(new WindowBoundsStore(file).restore([display])).toBeNull();
    fs.writeFileSync(file, '{oops');
    expect(new WindowBoundsStore(file).restore([display])).toBeNull();
    expect(new WindowBoundsStore(path.join(dir, 'missing.json')).restore([display])).toBeNull();
  });
});
