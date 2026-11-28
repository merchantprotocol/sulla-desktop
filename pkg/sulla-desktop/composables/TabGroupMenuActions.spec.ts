// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { TabGroupModel } from './TabGroupModel';
import { TabGroupColorPalette } from './TabGroupColorPalette';
import { TabGroupMenuActions } from './TabGroupMenuActions';
import { TabStripLayoutRepository, type TabStripStorage } from './TabStripLayoutRepository';

class MemoryStorage implements TabStripStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class TabGroupActionsFixture {
  readonly storage = new MemoryStorage();
  readonly repository = new TabStripLayoutRepository(this.storage, 'actions');
  readonly model = new TabGroupModel(this.repository, (() => {
    let sequence = 0;
    return () => `group-${ ++sequence }`;
  })());
  readonly closedTabIds: string[] = [];
  readonly blockedTabIds = new Set<string>();
  readonly colorPalette = new TabGroupColorPalette();
  liveTabIds: string[];
  readonly actions: TabGroupMenuActions;

  constructor(openTabIds: string[]) {
    this.liveTabIds = [...openTabIds];
    this.actions = new TabGroupMenuActions(this.model, this, this.colorPalette);
  }

  openTabIds(): readonly string[] { return this.liveTabIds; }

  async closeTabs(tabIds: readonly string[]): Promise<void> {
    const closable = tabIds.filter(tabId => !this.blockedTabIds.has(tabId));
    this.closedTabIds.push(...closable);
    const closed = new Set(closable);
    this.liveTabIds = this.liveTabIds.filter(tabId => !closed.has(tabId));
    this.model.pruneTabs(this.liveTabIds);
  }
}

describe('tab group menu actions', () => {
  it('creates a new group immediately with the selected tab and an optional empty name', () => {
    // risk: CRUD/data accuracy — an empty-name group must still include the requested tab.
    const fixture = new TabGroupActionsFixture(['tab-a']);

    const groupId = fixture.actions.addToNewGroup('tab-a');

    expect(fixture.model.groups).toMatchObject([{ id: groupId, name: '', colorToken: 'blue' }]);
    expect(fixture.model.membership).toEqual({ 'tab-a': groupId });
  });

  it('adds an open tab to the selected existing group', () => {
    // risk: data accuracy — membership must point the tab at the chosen group.
    const fixture = new TabGroupActionsFixture(['tab-a', 'tab-b']);
    const group = fixture.model.createGroup('Launch', 'blue', ['tab-a']);

    expect(fixture.actions.addToGroup('tab-b', group.id)).toBe(true);
    expect(fixture.model.membership).toEqual({ 'tab-a': group.id, 'tab-b': group.id });
  });

  it('removes only the chosen tab from its group', () => {
    // risk: data accuracy — removing one tab must retain the other members.
    const fixture = new TabGroupActionsFixture(['tab-a', 'tab-b']);
    const group = fixture.model.createGroup('Launch', 'blue', ['tab-a', 'tab-b']);

    expect(fixture.actions.removeFromGroup('tab-a')).toBe(true);
    expect(fixture.model.membership).toEqual({ 'tab-b': group.id });
    expect(fixture.model.groups.map(candidate => candidate.id)).toEqual([group.id]);
  });

  it('ungroups tabs without closing them', () => {
    // risk: irreversible side effects — Ungroup must not close any tab.
    const fixture = new TabGroupActionsFixture(['tab-a', 'tab-b']);
    const group = fixture.model.createGroup('Launch', 'blue', ['tab-a', 'tab-b']);

    expect(fixture.actions.ungroup(group.id)).toBe(true);
    expect(fixture.liveTabIds).toEqual(['tab-a', 'tab-b']);
    expect(fixture.closedTabIds).toEqual([]);
    expect(fixture.model.membership).toEqual({});
  });

  it('closes exactly the open tabs in the selected group and preserves other groups', async() => {
    // risk: irreversible side effects — Close Group must not close tabs outside its membership.
    const fixture = new TabGroupActionsFixture(['tab-a', 'tab-b', 'tab-c', 'tab-free']);
    const closing = fixture.model.createGroup('Launch', 'blue', ['tab-a', 'tab-b']);
    const staying = fixture.model.createGroup('Research', 'gold', ['tab-c']);

    expect(await fixture.actions.closeGroup(closing.id)).toEqual(['tab-a', 'tab-b']);
    expect(fixture.closedTabIds).toEqual(['tab-a', 'tab-b']);
    expect(fixture.liveTabIds).toEqual(['tab-c', 'tab-free']);
    expect(fixture.model.membership).toEqual({ 'tab-c': staying.id });
  });

  it('keeps a group containing tabs whose close guard declined', async() => {
    // risk: side effects — a denied close must not silently ungroup a still-open tab.
    const fixture = new TabGroupActionsFixture(['tab-a', 'tab-b', 'tab-outside']);
    const group = fixture.model.createGroup('Launch', 'blue', ['tab-a', 'tab-b']);
    fixture.blockedTabIds.add('tab-b');

    expect(await fixture.actions.closeGroup(group.id)).toEqual(['tab-a']);
    expect(fixture.closedTabIds).toEqual(['tab-a']);
    expect(fixture.liveTabIds).toEqual(['tab-b', 'tab-outside']);
    expect(fixture.model.membership).toEqual({ 'tab-b': group.id });
  });

  it('does not create a group for a stale tab', () => {
    // risk: stale-action safety — a closed tab must not create an empty group.
    const fixture = new TabGroupActionsFixture(['tab-a']);

    expect(() => fixture.actions.addToNewGroup('closed-tab')).toThrow(RangeError);
    expect(fixture.model.groups).toEqual([]);
  });
});
