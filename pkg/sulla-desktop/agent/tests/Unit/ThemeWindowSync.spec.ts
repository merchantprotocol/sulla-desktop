// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
const { on } = vi.hoisted(() => ({ on: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { on } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {} }));
vi.mock('@pkg/composables/useTypography', () => ({ startTypography: vi.fn() }));
import { ThemeStore } from '@pkg/composables/useTheme';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('cross-window theme synchronization', () => {
  it('updates shell classes from IPC without storage events or rebroadcasting', () => {
    const classes = new Set(['theme-studio-light']);
    vi.stubGlobal('document', { documentElement: { classList: {
      add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value),
    } } });
    const addEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener });
    const settings = { get: vi.fn(), set: vi.fn() };
    const store = new ThemeStore(settings);
    store.listenForOtherWindows(); store.listenForOtherWindows();
    expect(on).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    const receive = on.mock.calls[0][1];
    receive({}, 'default-dark');
    expect(store.currentTheme.value).toBe('default-dark');
    expect(classes.has('dark')).toBe(true);
    expect(classes.has('theme-studio-light')).toBe(false);
    receive({}, 'default-light');
    expect(classes.has('dark')).toBe(false);
    expect(classes.has('theme-default-dark')).toBe(false);
    expect(classes.has('theme-default-light')).toBe(true);
    receive({}, 'invalid');
    expect(store.currentTheme.value).toBe('default-light');
    expect(settings.set).not.toHaveBeenCalled();
  });
});
