// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { shouldRunGc, shouldStartFresh, WindowStorageMigrator, withHostedTab } from './windowStorage';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

describe('WindowStorageMigrator', () => {
  it('removes unknown window namespaces without touching vault data or main keys', () => {
    const storage = new MemoryStorage();
    storage.setItem('sulla:win:ghost:tabs', 'stale');
    storage.setItem('sulla:vault:x', 'secret');
    storage.setItem('sulla:win:main:browser-tabs', 'tabs');
    new WindowStorageMigrator().migrate(storage, ['sulla:win:ghost:tabs', 'sulla:vault:x', 'sulla:win:main:browser-tabs'], ['main'], false);
    expect(storage.getItem('sulla:win:ghost:tabs')).toBeNull();
    expect(storage.getItem('sulla:vault:x')).toBe('secret');
    expect(storage.getItem('sulla:win:main:browser-tabs')).toBe('tabs');
  });

  it('moves only legacy tab keys into main window storage once', () => {
    const storage = new MemoryStorage();
    storage.setItem('sulla:browser-tabs', 'old tabs');
    storage.setItem('sulla:vault:x', 'secret');
    new WindowStorageMigrator().migrate(storage, ['sulla:browser-tabs', 'sulla:vault:x'], ['main'], true);
    expect(storage.getItem('sulla:win:main:browser-tabs')).toBe('old tabs');
    expect(storage.getItem('sulla:vault:x')).toBe('secret');
    expect(storage.getItem('sulla:win:main:migrated')).toBe('1');
  });

  it('keeps other windows namespaces when the primary window reloads without GC', () => {
    const storage = new MemoryStorage();
    storage.setItem('sulla:win:w_new:browser-tabs', 'window C tabs');
    storage.setItem('sulla:win:main:migrated', '1');
    new WindowStorageMigrator().migrate(storage, ['sulla:win:w_new:browser-tabs'], null, true);
    expect(storage.getItem('sulla:win:w_new:browser-tabs')).toBe('window C tabs');
  });
});

describe('shouldRunGc', () => {
  it('runs once per session for the primary window only', () => {
    const session = new MemoryStorage();
    expect(shouldRunGc('main', session)).toBe(true);
    expect(shouldRunGc('main', session)).toBe(false);
  });

  it('never runs for a secondary window, and does not consume the session flag', () => {
    const session = new MemoryStorage();
    expect(shouldRunGc('w_abc', session)).toBe(false);
    expect(shouldRunGc('main', session)).toBe(true);
  });
});

describe('shouldStartFresh', () => {
  it('honours freshAgentTab=1 only on the first load of that window', () => {
    const session = new MemoryStorage();
    expect(shouldStartFresh('?windowKey=w_abc&freshAgentTab=1', session)).toBe(true);
    expect(shouldStartFresh('?windowKey=w_abc&freshAgentTab=1', session)).toBe(false);
  });

  it('ignores the param when absent, and keeps restoring after a reload', () => {
    const session = new MemoryStorage();
    expect(shouldStartFresh('?windowKey=main', session)).toBe(false);
    expect(shouldStartFresh('?windowKey=main&freshAgentTab=1', session)).toBe(true);
    expect(shouldStartFresh('?windowKey=main&freshAgentTab=1', session)).toBe(false);
  });
});

describe('withHostedTab', () => {
  it('adds the hosted tab when the saved list does not have it yet', () => {
    // risk: a tab host that starts before the debounced save shows the wrong page
    const saved = [{ id: 'a', mode: 'chat' }];
    expect(withHostedTab(saved, 'b', { id: 'b', mode: 'chat' })).toEqual([{ id: 'a', mode: 'chat' }, { id: 'b', mode: 'chat' }]);
  });

  it('prefers the owner window over the saved copy of the hosted tab', () => {
    const saved = [{ id: 'a', mode: 'chat', title: 'Old' }];
    expect(withHostedTab(saved, 'a', { id: 'a', mode: 'files', title: 'New' })).toEqual([{ id: 'a', mode: 'files', title: 'New' }]);
  });

  it('leaves the list alone outside a tab host or for a mismatched descriptor', () => {
    const saved = [{ id: 'a', mode: 'chat' }];
    expect(withHostedTab(saved, null, { id: 'b', mode: 'chat' })).toBe(saved);
    expect(withHostedTab(saved, 'b', null)).toBe(saved);
    expect(withHostedTab(saved, 'b', { id: 'c', mode: 'chat' })).toBe(saved);
  });
});
