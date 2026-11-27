// SPDX-License-Identifier: GPL-2.0-or-later
// Characterization of the shared composable stores (E18-S3). Each store is
// built with a fake IPC so these tests never touch Electron.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@pkg/composables/useTypography', () => ({ startTypography: vi.fn() }));

import { BookmarksStore } from './useBookmarks';
import { DecisionsStore } from './useDecisions';
import { LiveClock } from './useLiveClock';
import { DEFAULT_THEME, ThemeStore } from './useTheme';
import { PackageTopicsStore } from './packageTopics';

function fakeIpc(invoke: (channel: string, ...args: unknown[]) => unknown) {
  return { invoke: vi.fn(async(channel: string, ...args: unknown[]) => invoke(channel, ...args)), on: vi.fn(), removeListener: vi.fn() } as any;
}

describe('shared instances', () => {
  // risk: data accuracy — every component must see the same list, not a private copy
  it('shared() returns one instance per window', () => {
    expect(LiveClock.shared()).toBe(LiveClock.shared());
    expect(DecisionsStore.shared()).toBe(DecisionsStore.shared());
    expect(BookmarksStore.shared()).toBe(BookmarksStore.shared());
    expect(ThemeStore.shared()).toBe(ThemeStore.shared());
    expect(PackageTopicsStore.shared()).toBe(PackageTopicsStore.shared());
  });
});

describe('LiveClock', () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  it('runs one timer for many subscribers and stops after the last leaves', () => {
    const clock = new LiveClock();
    clock.subscribe();
    clock.subscribe();
    expect(vi.getTimerCount()).toBe(1);
    const before = clock.now.value;
    vi.advanceTimersByTime(2000);
    expect(clock.now.value).toBeGreaterThan(before);
    clock.unsubscribe();
    expect(vi.getTimerCount()).toBe(1);
    clock.unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DecisionsStore', () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  it('subscribes once for the first consumer and unsubscribes after the last', async() => {
    const ipc = fakeIpc(() => [{ id: 'd1' }]);
    const store = new DecisionsStore(ipc);
    store.attach();
    store.attach();
    expect(ipc.on).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(store.records.value).toEqual([{ id: 'd1' }]));
    store.detach();
    expect(ipc.removeListener).not.toHaveBeenCalled();
    store.detach();
    expect(ipc.removeListener).toHaveBeenCalledWith('decisions:changed', ipc.on.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the last records and sets a friendly error when the list fails', async() => {
    const ipc = fakeIpc(() => { throw new Error('db down') });
    const store = new DecisionsStore(ipc);
    store.records.value = [{ id: 'kept' } as any];
    await store.refresh();
    expect(store.error.value).toBe('Could not refresh decisions. Try again.');
    expect(store.records.value).toEqual([{ id: 'kept' }]);
  });
});

describe('BookmarksStore', () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  it('a mutation reloads the shared list after the IPC call', async() => {
    const rows = [{ id: 'b1' }];
    const ipc = fakeIpc(channel => (channel === 'bookmarks:list' ? rows : 'created'));
    const store = new BookmarksStore(ipc);
    const result = await store.mutate(i => i.invoke('bookmarks:create', { kind: 'folder' }));
    expect(result).toBe('created');
    expect(ipc.invoke.mock.calls.map((c: unknown[]) => c[0])).toEqual(['bookmarks:create', 'bookmarks:list']);
    expect(store.records.value).toEqual(rows);
    expect(store.loaded.value).toBe(true);
  });

  it('retries once after a failed load and recovers', async() => {
    let fail = true;
    const ipc = fakeIpc(() => { if (fail) throw new Error('not ready'); return [{ id: 'b2' }] });
    const store = new BookmarksStore(ipc);
    await store.refresh();
    expect(store.error.value).toBe('not ready');
    expect(store.loaded.value).toBe(false);
    fail = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.records.value).toEqual([{ id: 'b2' }]);
    expect(store.error.value).toBeNull();
  });

  it('subscribes to change events only once', () => {
    const ipc = fakeIpc(() => []);
    const store = new BookmarksStore(ipc);
    store.subscribe();
    store.subscribe();
    expect(ipc.on).toHaveBeenCalledTimes(1);
  });
});

describe('PackageTopicsStore', () => {
  it('loads topics once for concurrent callers and labels unknown keys More', async() => {
    const ipc = fakeIpc(() => ({ topics: [{ key: 'sales', label: 'Sales' }] }));
    const store = new PackageTopicsStore(ipc);
    await Promise.all([store.load(), store.load()]);
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    expect(store.label('sales')).toBe('Sales');
    expect(store.label('nope')).toBe('More');
  });

  it('keeps existing topics when the marketplace returns an error', async() => {
    const store = new PackageTopicsStore(fakeIpc(() => ({ error: 'offline' })));
    store.topics.value = [{ key: 'k', label: 'K' } as any];
    await store.load();
    expect(store.topics.value).toEqual([{ key: 'k', label: 'K' }]);
  });
});

describe('ThemeStore', () => {
  it('validates ids and migrates legacy names', () => {
    expect(ThemeStore.isValidTheme('nord-dark')).toBe(true);
    expect(ThemeStore.isValidTheme('purple')).toBe(false);
    expect(ThemeStore.migrateLegacyTheme('dark')).toBe('default-dark');
    expect(ThemeStore.migrateLegacyTheme('ocean')).toBe('ocean-dark');
    expect(ThemeStore.migrateLegacyTheme('nord-dark')).toBeNull();
  });

  it.each(['ocean-dark', 'nord-light', 'invalid'])('applies the cached theme %s before consulting settings', (cached) => {
    const classes = new Set(['theme-noir-dark', 'dark']);
    vi.stubGlobal('document', { documentElement: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } } });
    vi.stubGlobal('localStorage', { getItem: () => cached });
    try {
      const settings = { get: vi.fn(), set: vi.fn() };
      const store = new ThemeStore(settings);
      store.applyCachedTheme();
      const expected = cached === 'invalid' ? DEFAULT_THEME : cached;
      expect(classes.has(`theme-${ expected }`)).toBe(true);
      expect(classes.has('dark')).toBe(expected.endsWith('-dark'));
      expect(settings.get).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loads a saved theme, migrating a legacy value, and falls back to the default', async() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
    try {
      expect(await new ThemeStore({ get: vi.fn(async() => 'noir-dark'), set: vi.fn() } as any).loadThemeFromSettings()).toBe('noir-dark');
      expect(await new ThemeStore({ get: vi.fn(async() => 'protocol'), set: vi.fn() } as any).loadThemeFromSettings()).toBe('protocol-dark');
      expect(await new ThemeStore({ get: vi.fn(async() => { throw new Error('no db') }), set: vi.fn() } as any).loadThemeFromSettings()).toBe(DEFAULT_THEME);
      storage.set('agentTheme', 'light');
      expect(await new ThemeStore({ get: vi.fn(async() => null), set: vi.fn() } as any).loadThemeFromSettings()).toBe('default-light');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
