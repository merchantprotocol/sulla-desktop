// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const windowKey = (search: string): string => new URLSearchParams(search).get('windowKey') || 'main';
export const storageKey = (key: string, name: string): string => `sulla:win:${ key }:${ name }`;

const legacyTabKeys = ['browser-tabs', 'closed-tabs', 'tab-order', 'pinned-tabs', 'active-tab'];

export class WindowStorageMigrator {
  migrate(storage: Storage, keys: Iterable<string>, knownKeys: Iterable<string>, isPrimary: boolean): void {
    const known = new Set(knownKeys);
    for (const key of keys) {
      const match = /^sulla:win:([^:]+):/.exec(key);
      if (match && !known.has(match[1])) storage.removeItem(key);
    }
    const migratedKey = storageKey('main', 'migrated');
    if (!isPrimary || storage.getItem(migratedKey) === '1') return;
    for (const name of legacyTabKeys) {
      const legacy = `sulla:${ name }`;
      const target = storageKey('main', name);
      if (storage.getItem(target) === null && storage.getItem(legacy) !== null) storage.setItem(target, storage.getItem(legacy)!);
      storage.removeItem(legacy);
    }
    storage.setItem(migratedKey, '1');
  }
}
