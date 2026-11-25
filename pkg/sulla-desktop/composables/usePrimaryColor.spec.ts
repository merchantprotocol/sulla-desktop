// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

// The store receives its settings and IPC through the constructor; these keep the Electron and database modules out of the import graph.
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { on: vi.fn() } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } }));

import { PRIMARY_COLOR_SETTING_KEY, PRIMARY_COLOR_STORAGE_KEY } from '@pkg/config/primaryColor';
import { PrimaryColorStore } from './usePrimaryColor';

function createHarness(saved: string | null = null) {
  const values = new Map<string, string>();
  if (saved !== null) values.set(PRIMARY_COLOR_SETTING_KEY, saved);
  const localValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localValues.set(key, value); },
    removeItem: (key: string) => { localValues.delete(key); },
  };
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    style: {
      setProperty: (key: string, value: string) => { properties.set(key, value); },
      removeProperty: (key: string) => { properties.delete(key); },
    },
    classList: {
      toggle: (key: string, enabled: boolean) => { enabled ? classes.add(key) : classes.delete(key); },
    },
  };
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const settings = {
    get: vi.fn(async(key: string, fallback: unknown = null) => values.get(key) ?? fallback),
    set: vi.fn(async(key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async(key: string) => { values.delete(key); }),
  };
  const ipc = { on: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) => { listeners.set(channel, listener); }) };

  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('window', { addEventListener: vi.fn() });

  return { store: new PrimaryColorStore(settings as any, ipc as any), settings, ipc, values, localValues, properties, classes, listeners };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('primary color persistence and window synchronization', () => {
  // risk: data accuracy — the selection is visible synchronously and restored from the durable setting after a new window starts.
  it('mirrors a choice synchronously and reloads it from persisted settings', async() => {
    const first = createHarness();
    first.store.set('#6B57C9');
    expect(first.store.primaryColor.value).toBe('#6b57c9');
    expect(first.localValues.get(PRIMARY_COLOR_STORAGE_KEY)).toBe('#6b57c9');
    await Promise.resolve();

    const second = createHarness(first.values.get(PRIMARY_COLOR_SETTING_KEY) ?? null);
    second.localValues.clear();
    second.store.start();
    await vi.waitFor(() => expect(second.store.primaryColor.value).toBe('#6b57c9'));
    expect(second.properties.get('--accent-primary')).toBe('#6b57c9');
  });

  // risk: data accuracy — reset removes the override instead of persisting a theme-independent fallback.
  it('deletes the saved key and removes every primary override on reset', async() => {
    const harness = createHarness();
    harness.store.set('#2b7694');
    await Promise.resolve();
    harness.store.reset();
    await Promise.resolve();

    expect(harness.settings.delete).toHaveBeenCalledWith(PRIMARY_COLOR_SETTING_KEY);
    expect(harness.values.has(PRIMARY_COLOR_SETTING_KEY)).toBe(false);
    expect(harness.localValues.has(PRIMARY_COLOR_STORAGE_KEY)).toBe(false);
    expect(harness.properties.has('--accent-primary')).toBe(false);
    expect(harness.store.primaryColor.value).toBeNull();
  });

  // risk: permissions/RBAC — untrusted renderer input must never reach storage or CSS.
  it('ignores invalid input without changing the active color or persisted value', () => {
    const harness = createHarness();
    harness.store.set('url(javascript:alert(1))');

    expect(harness.settings.set).not.toHaveBeenCalled();
    expect(harness.localValues.has(PRIMARY_COLOR_STORAGE_KEY)).toBe(false);
    expect(harness.store.primaryColor.value).toBeNull();
  });

  // risk: data accuracy/accessibility — switching light/dark recomputes live fills without changing the chosen or stored color.
  it('re-derives the applied palette when the active theme changes mode', async() => {
    const harness = createHarness();
    harness.store.set('#6b57c9');
    await Promise.resolve();
    const lightFill = harness.properties.get('--accent-primary');

    harness.store.setMode('dark');

    expect(harness.store.primaryColor.value).toBe('#6b57c9');
    expect(harness.values.get(PRIMARY_COLOR_SETTING_KEY)).toBe('#6b57c9');
    expect(harness.properties.get('--accent-primary')).not.toBe(lightFill);
    expect(harness.properties.get('--mk-accent')).toBe(harness.properties.get('--accent-primary'));
    expect(harness.settings.set).toHaveBeenCalledTimes(1);
  });

  // risk: data accuracy — cross-window set and delete broadcasts apply locally without another persistence write.
  it('applies IPC set/delete events without rebroadcasting or persisting them', () => {
    const harness = createHarness();
    harness.store.start();
    const receive = harness.listeners.get('sulla:primary-color-changed')!;
    receive({}, '#3d4654');

    expect(harness.store.primaryColor.value).toBe('#3d4654');
    expect(harness.properties.get('--accent-primary')).toBe('#3d4654');
    expect(harness.settings.set).not.toHaveBeenCalled();
    expect(harness.localValues.has(PRIMARY_COLOR_STORAGE_KEY)).toBe(false);
    receive({}, 'url(javascript:alert(1))');
    expect(harness.store.primaryColor.value).toBe('#3d4654');
    expect(harness.properties.get('--accent-primary')).toBe('#3d4654');
    receive({}, null);
    expect(harness.store.primaryColor.value).toBeNull();
    expect(harness.properties.has('--accent-primary')).toBe(false);
    expect(harness.settings.delete).not.toHaveBeenCalled();
  });
});
