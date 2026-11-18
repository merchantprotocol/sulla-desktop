// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { WindowStorageMigrator } from './windowStorage';

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
});
