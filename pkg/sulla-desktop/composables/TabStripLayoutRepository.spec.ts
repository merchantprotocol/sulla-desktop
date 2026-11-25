// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { TabGroupModel } from './TabGroupModel';
import { TabGroupReveal } from './TabGroupReveal';
import { TabStripLayoutRepository } from './TabStripLayoutRepository';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('TabStripLayoutRepository', () => {
  it('reveals only a changed unpinned selection, preserving a restored or manually folded active group', () => {
    const storage = new MemoryStorage();
    const layout = new TabStripLayoutRepository(storage, 'window');
    const chat = { id: 'chat', mode: 'chat' };
    const browser = { id: 'first-browser', mode: 'browser' };
    const reveal = new TabGroupReveal(new TabGroupModel(), layout, chat);

    layout.setFoldedGroups(['chats', 'browser', 'tools']);
    reveal.select(chat);
    expect(layout.foldedGroups.value).toEqual(['chats', 'browser', 'tools']);
    reveal.select(browser);
    expect(layout.foldedGroups.value).toEqual(['chats', 'tools']);

    layout.setFoldedGroups(['chats', 'browser', 'tools']);
    reveal.select({ ...browser }); // The native browser header replaces the shell header.
    expect(layout.foldedGroups.value).toContain('browser');
    reveal.select({ id: 'pinned-tool', mode: 'vault', pinned: true });
    expect(layout.foldedGroups.value).toContain('tools');
    reveal.select(browser);
    expect(layout.foldedGroups.value).not.toContain('browser');
  });

  it('reveals the same active id after unpin or group change, but keeps an explicit fold in the same placement', () => {
    const layout = new TabStripLayoutRepository(new MemoryStorage(), 'window');
    const reveal = new TabGroupReveal(new TabGroupModel(), layout);
    const tool = { id: 'active', mode: 'calendar' };

    layout.setFoldedGroups(['chats', 'browser', 'tools']);
    reveal.select({ ...tool, pinned: true });
    expect(layout.foldedGroups.value).toContain('tools');
    reveal.select({ ...tool, pinned: false });
    expect(layout.foldedGroups.value).not.toContain('tools');

    layout.setFoldedGroups(['chats', 'browser', 'tools']);
    reveal.select({ ...tool, mode: 'vault' });
    expect(layout.foldedGroups.value).toContain('tools');
    reveal.select({ ...tool, mode: 'browser' });
    expect(layout.foldedGroups.value).toEqual(['chats', 'tools']);
  });

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
