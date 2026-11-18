// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

// BrowserTabViewIpc -> window/agentWindowTrust -> window/index registers app listeners
// at load, so the electron stub needs the same app surface as browserTabViewManager.spec.
vi.mock('electron', () => {
  const app = { on: () => {}, off: () => {}, getPath: () => '/tmp', quit: () => {}, isPackaged: false, dock: undefined };
  return {
    default: { app, BrowserWindow: { fromWebContents: () => null } },
    app,
    BrowserWindow: { fromWebContents: () => null },
    WebContentsView: class {},
  };
});

import { focusTabForOwner } from './BrowserTabViewIpc';

describe('browser-tab focus ownership', () => {
  it('ignores an unowned tab id but rejects another window’s tab', () => {
    // risk: startup IPC noise and cross-window focus/ownership isolation
    const caller = {} as Electron.BrowserWindow;
    const other = {} as Electron.BrowserWindow;
    const setFocused = vi.fn();
    expect(() => focusTabForOwner(setFocused, 'not-created-yet', caller, null)).not.toThrow();
    expect(setFocused).not.toHaveBeenCalled();
    expect(() => focusTabForOwner(setFocused, 'foreign-tab', caller, other)).toThrow('not owned by this window');
    expect(setFocused).not.toHaveBeenCalled();
  });
});
