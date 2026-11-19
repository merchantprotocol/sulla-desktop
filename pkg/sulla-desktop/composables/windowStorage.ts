// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const windowKey = (search: string): string => new URLSearchParams(search).get('windowKey') || 'main';
export const storageKey = (key: string, name: string): string => `sulla:win:${ key }:${ name }`;

// Per-webContents sessionStorage survives a reload of that window but not an app restart.
export type SessionFlags = Pick<Storage, 'getItem' | 'setItem'>;
const GC_RAN_FLAG = 'sulla:gc-ran';
const FRESH_STARTED_FLAG = 'sulla:fresh-started';

/**
 * True only for the primary window, and only once per app session. Claiming the
 * run sets the session flag, so a reload of the primary window never re-runs GC
 * with a stale knownWindowKeys list (which would delete a newer window's tabs).
 */
export const shouldRunGc = (windowKey: string, session: SessionFlags): boolean => {
  if (windowKey !== 'main' || session.getItem(GC_RAN_FLAG) === '1') return false;
  session.setItem(GC_RAN_FLAG, '1');
  return true;
};

/**
 * freshAgentTab=1 asks for an empty tab set, but only on the first load of that
 * window. Later reloads must restore the tabs that window already saved.
 */
export const shouldStartFresh = (search: string, session: SessionFlags): boolean => {
  if (new URLSearchParams(search).get('freshAgentTab') !== '1' || session.getItem(FRESH_STARTED_FLAG) === '1') return false;
  session.setItem(FRESH_STARTED_FLAG, '1');
  return true;
};

/**
 * A tab-host renderer shows one tab, and its owner window is the authority on
 * that tab. The saved tab list is written on a delay and leaves out some tabs,
 * so a host that starts right after its tab was opened would not find it there.
 */
export const withHostedTab = <T extends { id: string }>(restored: T[], hostedId: string | null, descriptor: unknown): T[] => {
  const hosted = descriptor as T | null | undefined;
  if (!hostedId || !hosted || typeof hosted !== 'object' || hosted.id !== hostedId) return restored;
  const index = restored.findIndex(tab => tab.id === hostedId);
  if (index < 0) return [...restored, hosted];
  return restored.map((tab, i) => (i === index ? { ...tab, ...hosted } : tab));
};

const legacyTabKeys = ['browser-tabs', 'closed-tabs', 'tab-order', 'pinned-tabs', 'active-tab'];

export class WindowStorageMigrator {
  /** knownKeys = null skips the namespace GC pass (legacy migration still runs when isPrimary). */
  migrate(storage: Storage, keys: Iterable<string>, knownKeys: Iterable<string> | null, isPrimary: boolean): void {
    if (knownKeys) {
      const known = new Set(knownKeys);
      for (const key of keys) {
        const match = /^sulla:win:([^:]+):/.exec(key);
        if (match && !known.has(match[1])) storage.removeItem(key);
      }
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
