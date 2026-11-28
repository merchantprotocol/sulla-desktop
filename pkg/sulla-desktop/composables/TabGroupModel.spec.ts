// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { TabGroupModel } from './TabGroupModel';
import { TabStripLayoutRepository, type TabStripStorage } from './TabStripLayoutRepository';

class MemoryStorage implements TabStripStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string): void { this.entries.set(key, value); }
}

class GroupFixture {
  private nextId = 0;
  readonly repository: TabStripLayoutRepository;
  readonly model: TabGroupModel;

  constructor(storage = new MemoryStorage(), key = 'window-a') {
    this.repository = new TabStripLayoutRepository(storage, key);
    this.model = new TabGroupModel(this.repository, () => `generated-${ ++this.nextId }`);
  }
}

describe('TabGroupModel', () => {
  it('trims names, preserves Unicode, permits blanks, and caps names at 60 characters', () => {
    // risk: data integrity — names must be trimmed and bounded without splitting Unicode characters.
    const { model } = new GroupFixture();
    const group = model.createGroup(`  ${ 'x'.repeat(59) }🧪tail  `, 'blue', ['tab-a']);
    const unnamed = model.createGroup(' \t ', 'grey', ['tab-b']);

    expect(group.name).toBe(`${ 'x'.repeat(59) }🧪`);
    expect(Array.from(group.name)).toHaveLength(60);
    expect(unnamed.name).toBe('');
    expect(model.renameGroup(group.id, '   ')).toBe(true);
    expect(model.groups.find(candidate => candidate.id === group.id)?.name).toBe('');
    expect(() => model.setGroupColor(group.id, 'violet' as never)).toThrow(RangeError);
  });

  it('renames and recolors an existing group', () => {
    // risk: data integrity — edits must update stored group metadata.
    const { model } = new GroupFixture();
    const group = model.createGroup('Inbox', 'blue', ['tab-a']);

    expect(model.renameGroup(group.id, '  Follow ups  ')).toBe(true);
    expect(model.setGroupColor(group.id, 'gold')).toBe(true);
    expect(model.groups[0]).toMatchObject({ name: 'Follow ups', colorToken: 'gold' });
  });

  it('moves initial members from their previous group and removes the group left empty', () => {
    // risk: data integrity — reassignment must not leave orphan groups.
    const { model } = new GroupFixture();
    const original = model.createGroup('Original', 'blue', ['tab-a']);
    const replacement = model.createGroup('Replacement', 'purple', ['tab-a']);

    expect(model.getGroupIdForTab('tab-a')).toBe(replacement.id);
    expect(model.groups).toEqual([{ ...replacement, order: 0 }]);
    expect(model.groups.some(group => group.id === original.id)).toBe(false);
  });

  it('prunes stale membership and removes a group when its last tab closes', () => {
    // risk: data integrity — stale tab IDs must not survive reconciliation.
    const { model } = new GroupFixture();
    const group = model.createGroup('Temporary', 'cyan', ['tab-live', 'tab-closed']);

    model.pruneTabs(['tab-live']);
    expect(model.getGroupIdForTab('tab-closed')).toBeUndefined();
    expect(model.groups).toHaveLength(1);

    model.pruneTabs([]);
    expect(model.groups).toEqual([]);
    expect(model.membership).toEqual({});
    expect(group.id).toBe('generated-1');
  });

  it('moves a dragged tab between groups, restores its prior group on cancel, and ungroups on drop in the normal row', () => {
    // risk: data integrity — canceled drags must restore membership and order.
    const { model } = new GroupFixture();
    const source = model.createGroup('Source', 'blue', ['dragged', 'source-peer']);
    const target = model.createGroup('Target', 'orange', ['target-peer']);
    const originalGroups = model.groups;

    expect(model.moveTabToGroup('dragged', target.id, true)).toBe(true); // live drag reflow
    expect(model.getGroupIdForTab('dragged')).toBe(target.id);
    expect(model.groups.find(group => group.id === source.id)).toBeDefined();
    expect(model.moveTabToGroup('dragged', source.id, true)).toBe(true); // Escape restores membership
    expect(model.getGroupIdForTab('dragged')).toBe(source.id);
    expect(model.groups).toEqual(originalGroups);

    expect(model.moveTabToGroup('dragged')).toBe(true); // drop into ungrouped row
    model.pruneEmptyGroups();
    expect(model.getGroupIdForTab('dragged')).toBeUndefined();
    expect(model.groups.map(group => group.id)).toEqual([source.id, target.id]);
  });

  it('orders membership by user group order while preserving order within each row', () => {
    // risk: data accuracy — group ordering must not scramble tabs within a row.
    const { model } = new GroupFixture();
    const first = model.createGroup('First', 'blue', ['first-a', 'first-b']);
    const second = model.createGroup('Second', 'purple', ['second-a']);
    const tabs = [
      { id: 'second-a' },
      { id: 'free' },
      { id: 'first-b' },
      { id: 'pinned', pinned: true },
      { id: 'first-a' },
    ];

    expect(model.orderTabs(tabs, tabs.map(tab => tab.id)).map(tab => tab.id)).toEqual([
      'pinned', 'free', 'first-b', 'first-a', 'second-a',
    ]);
    expect(model.reorder(second.id, 0)).toBe(true);
    expect(model.orderTabs(tabs, tabs.map(tab => tab.id)).map(tab => tab.id)).toEqual([
      'pinned', 'free', 'second-a', 'first-b', 'first-a',
    ]);
    expect(model.reorder(first.id, 1)).toBe(true);
  });
});
