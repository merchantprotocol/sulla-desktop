// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const app = { on: () => {}, off: () => {}, getPath: () => '/tmp', quit: () => {}, isPackaged: false };
  return { default: { app }, app, BrowserWindow: class {} };
});
import { matchesShortcutModifiers, WindowShortcuts } from './shortcuts';

describe('shortcut modifier matching', () => {
  it('requires exact modifiers for Cmd+N', () => {
    // risk: unintended chat tab creation from Cmd+Shift+N (new window)
    const cmdN = { meta: true, key: 'N' } as Electron.Input;
    const cmdShiftN = { meta: true, shift: true, key: 'N' } as Electron.Input;
    expect(matchesShortcutModifiers(cmdN, { meta: true, key: 'N' })).toBe(true);
    expect(matchesShortcutModifiers(cmdShiftN, { meta: true, key: 'N' })).toBe(false);
  });
});


describe('window shortcut input events', () => {
  it('does not invoke matching shortcuts on keyUp', () => {
    // risk: one physical key press triggers an irreversible shortcut twice
    let listener: ((event: any, input: any) => void) | undefined;
    const window = { id: 1, webContents: { on: (_event: string, callback: typeof listener) => { listener = callback; }, off: () => undefined } } as any;
    const shortcuts = new WindowShortcuts(window);
    const callback = vi.fn();
    shortcuts.addShortcut({ key: 'N', meta: true, callback } as any);
    const preventDefault = vi.fn();
    listener?.({ preventDefault }, { type: 'keyUp', key: 'N', meta: true });
    expect(callback).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    listener?.({ preventDefault }, { type: 'keyDown', key: 'N', meta: true });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});
