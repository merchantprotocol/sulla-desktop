// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { TabStripLayoutRepository } from './TabStripLayoutRepository';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('TabStripLayoutRepository', () => {
  it('defaults only Tools to folded on a fresh profile', () => {
    const storage = new MemoryStorage();
    expect(new TabStripLayoutRepository(storage, 'sulla:win:main:tab-strip-layout').loadFoldedGroups()).toEqual(['tools']);
  });

  it('round-trips folded groups through the per-window storage key', () => {
    const storage = new MemoryStorage();
    const key = 'sulla:win:window-2:tab-strip-layout';
    const writer = new TabStripLayoutRepository(storage, key);
    writer.saveFoldedGroups(['browser', 'chats', 'browser', 'invalid']);

    expect(new TabStripLayoutRepository(storage, key).loadFoldedGroups()).toEqual(['browser', 'chats']);
    expect(storage.getItem(key)).toBe('["browser","chats"]');
  });

  it('shares a reactive fold owner only for repositories on the same window key', () => {
    const storage = new MemoryStorage();
    const key = 'sulla:win:window-3:tab-strip-layout';
    const first = new TabStripLayoutRepository(storage, key);
    const second = new TabStripLayoutRepository(storage, key);
    const otherWindow = new TabStripLayoutRepository(storage, 'sulla:win:window-4:tab-strip-layout');

    first.setFoldedGroups(['browser']);

    expect(second.foldedGroups).toBe(first.foldedGroups);
    expect(second.foldedGroups.value).toEqual(['browser']);
    expect(otherWindow.foldedGroups.value).toEqual(['tools']);
  });

  it('recovers safely from malformed stored layout', () => {
    const storage = new MemoryStorage();
    storage.setItem('layout', '{broken');
    expect(new TabStripLayoutRepository(storage, 'layout').loadFoldedGroups()).toEqual(['tools']);
  });
});
