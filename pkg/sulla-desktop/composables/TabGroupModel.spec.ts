// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { calculateTabStripLayout, TabGroupModel, type TabStripLayoutGroup } from './TabGroupModel';

describe('TabGroupModel', () => {
  const model = new TabGroupModel();

  const layoutGroup = (id: TabStripLayoutGroup['id'], tabs: TabStripLayoutGroup['tabs'], baseWidth = 80): TabStripLayoutGroup => ({
    id,
    tabs,
    baseWidth,
    foldedWidth: baseWidth - 10,
  });

  it('maps chat, legacy secretary and Secretary conversations to Chats, browser to Browser, and all other modes to Tools', () => {
    expect(model.groupForMode('chat')).toBe('chats');
    expect(model.groupForMode('secretary')).toBe('chats');
    expect(model.groupForMode('conversations')).toBe('chats');
    expect(model.groupForMode('browser')).toBe('browser');
    for (const mode of ['welcome', 'calendar', 'vault', 'files', undefined]) {
      expect(model.groupForMode(mode)).toBe('tools');
    }
  });

  it('keeps pinned tabs before ordered automatic groups and preserves order within each group', () => {
    const grouped = model.groupTabs([
      { id: 'tool', mode: 'vault' },
      { id: 'chat-2', mode: 'secretary' },
      { id: 'browser', mode: 'browser' },
      { id: 'pin', mode: 'vault', pinned: true },
      { id: 'chat-1', mode: 'chat' },
    ]);
    expect(grouped.pinned.map(tab => tab.id)).toEqual(['pin']);
    expect(grouped.groups.map(group => [group.id, group.tabs.map(tab => tab.id)])).toEqual([
      ['chats', ['chat-2', 'chat-1']],
      ['browser', ['browser']],
      ['tools', ['tool']],
    ]);
  });

  it('selects all ordinals in grouped display order and reserves 9 for the last tab', () => {
    const tabs = model.orderTabs([
      { id: 'folded-tool', mode: 'vault' },
      { id: 'folded-browser', mode: 'browser' },
      { id: 'chat', mode: 'chat' },
      { id: 'pinned', mode: 'vault', pinned: true },
    ], []);
    expect(['1', '2', '3', '4', '5', '9'].map(key => model.shortcutTab(tabs, key)?.id)).toEqual([
      'pinned', 'chat', 'folded-browser', 'folded-tool', undefined, 'folded-tool',
    ]);
    const many = tabs.concat(Array.from({ length: 8 }, (_, index) => ({ id: `tool-${ index }`, mode: 'vault' })));
    expect(model.shortcutTab(many, '9')?.id).toBe('tool-7');
  });

  it('clamps reorder and start/end moves to the moving tab group', () => {
    const ids = ['p1', 'p2', 'c1', 'c2', 'b1', 't1', 't2'];
    const modes = new Map([
      ['c1', 'chat'], ['c2', 'secretary'], ['b1', 'browser'], ['t1', 'vault'], ['t2', 'calendar'],
    ]);
    const pinned = ['p1', 'p2'];

    expect(model.reorderTabIds(ids, 2, 6, modes, pinned)).toEqual(['p1', 'p2', 'c2', 'c1', 'b1', 't1', 't2']);
    expect(model.reorderTabIds(ids, 3, 0, modes, pinned)).toEqual(['p1', 'p2', 'c2', 'c1', 'b1', 't1', 't2']);
    expect(model.moveToBoundary(ids, 'c2', 'start', modes, pinned)).toEqual(['p1', 'p2', 'c2', 'c1', 'b1', 't1', 't2']);
    expect(model.moveToBoundary(ids, 'c1', 'end', modes, pinned)).toEqual(['p1', 'p2', 'c2', 'c1', 'b1', 't1', 't2']);
    expect(model.moveToBoundary(ids, 'b1', 'start', modes, pinned)).toEqual(ids);
  });

  it('never loses, duplicates, or cross-moves IDs across deterministic shuffled drags', () => {
    const modes = new Map<string, string | undefined>();
    const pinned: string[] = [];
    const original = Array.from({ length: 15 }, (_, index) => {
      const id = `tab-${ index }`;
      modes.set(id, index % 3 === 0 ? 'chat' : index % 3 === 1 ? 'browser' : 'calendar');
      return id;
    });
    let seed = 0x51a7;
    const random = (limit: number) => {
      seed = (seed * 16807) % 2147483647;
      return seed % limit;
    };
    let current = [...original];

    for (let step = 0; step < 180; step++) {
      const before = model.orderTabIds(current, modes, pinned);
      const groupById = new Map(before.map(id => [id, model.groupForMode(modes.get(id))]));
      const from = random(before.length);
      const to = random(before.length);
      const after = model.reorderTabIds(before, from, to, modes, pinned);

      expect([...after].sort()).toEqual([...original].sort());
      expect(new Set(after).size).toBe(original.length);
      for (const group of ['chats', 'browser', 'tools']) {
        const beforeGroup = before.filter(id => groupById.get(id) === group);
        const afterGroup = after.filter(id => groupById.get(id) === group);
        expect(afterGroup).toHaveLength(beforeGroup.length);
      }
      current = after;
    }
  });

  it('counts only needs-you tabs, not stalled tabs', () => {
    expect(model.needsYouCount([
      { activity: 'working' }, { activity: 'waiting' }, { activity: 'you' }, { activity: 'stalled' }, { activity: 'idle' },
    ])).toBe(1);
  });

  it('leaves every group expanded when the content-sized layout fits', () => {
    const layout = calculateTabStripLayout({
      groups: [
        layoutGroup('chats', [{ id: 'chat', width: 110, active: true }]),
        layoutGroup('browser', [{ id: 'browser', width: 90 }]),
        layoutGroup('tools', [{ id: 'tools', width: 100 }]),
      ],
      activeGroup: 'chats',
      availableWidth: 570,
    });

    expect(layout.map(group => group.presentation)).toEqual(['expanded', 'expanded', 'expanded']);
    expect(layout.map(group => group.width)).toEqual([190, 170, 180]);
  });

  it('compacts the non-active capsules first while preserving every compact tab icon when they fit', () => {
    const layout = calculateTabStripLayout({
      groups: [
        layoutGroup('chats', [{ id: 'chat', width: 110, active: true }]),
        layoutGroup('browser', [{ id: 'browser', width: 90 }]),
        layoutGroup('tools', [{ id: 'tools', width: 100 }]),
      ],
      activeGroup: 'chats',
      availableWidth: 420,
    });

    expect(layout.map(group => group.presentation)).toEqual(['expanded', 'compact', 'compact']);
    expect(layout.map(group => group.visibleTabIds)).toEqual([['chat'], ['browser'], ['tools']]);
    expect(layout.reduce((total, group) => total + group.width, 0) + 16).toBeLessThanOrEqual(420);
  });

  it('keeps two non-active groups compact when each has several tabs', () => {
    const layout = calculateTabStripLayout({
      groups: [
        layoutGroup('chats', [{ id: 'chat', width: 110, active: true }]),
        layoutGroup('browser', [{ id: 'b1', width: 80 }, { id: 'b2', width: 90 }]),
        layoutGroup('tools', [{ id: 't1', width: 70 }, { id: 't2', width: 100 }]),
      ],
      activeGroup: 'chats',
      availableWidth: 475,
    });

    expect(layout.map(group => group.presentation)).toEqual(['expanded', 'compact', 'compact']);
    expect(layout[1].visibleTabIds).toEqual(['b1', 'b2']);
    expect(layout[2].visibleTabIds).toEqual(['t1', 't2']);
    expect(layout[1].overflowCount).toBe(0);
    expect(layout[2].overflowCount).toBe(0);
  });

  it('caps compact icons and returns a +N overflow count without pushing the active group offscreen', () => {
    const manyTabs = (prefix: string) => Array.from({ length: 10 }, (_, index) => ({ id: `${ prefix }${ index }`, width: 80 }));
    const layout = calculateTabStripLayout({
      groups: [
        layoutGroup('chats', [{ id: 'chat', width: 120, active: true }], 90),
        layoutGroup('browser', manyTabs('b'), 90),
        layoutGroup('tools', manyTabs('t'), 90),
      ],
      activeGroup: 'chats',
      availableWidth: 520,
    });

    expect(layout.map(group => group.presentation)).toEqual(['expanded', 'compact', 'compact']);
    expect(layout[1].visibleTabIds.length).toBeLessThan(10);
    expect(layout[2].visibleTabIds.length).toBeLessThan(10);
    expect(layout[1].overflowCount).toBe(10 - layout[1].visibleTabIds.length);
    expect(layout[2].overflowCount).toBe(10 - layout[2].visibleTabIds.length);
    expect(layout.reduce((total, group) => total + group.width, 0) + 16).toBeLessThanOrEqual(520);
  });

  it('levels the widest tabs together without crossing their floors', () => {
    const layout = calculateTabStripLayout({
      groups: [
        layoutGroup('chats', [
          { id: 'long', width: 300 },
          { id: 'busy', width: 180, busy: true },
          { id: 'short', width: 90 },
          { id: 'active', width: 220, active: true },
        ], 100),
        layoutGroup('browser', [{ id: 'browser', width: 80 }], 60),
        layoutGroup('tools', [{ id: 'tools', width: 80 }], 60),
      ],
      activeGroup: 'chats',
      availableWidth: 880,
    });

    expect(layout[0].tabWidths.get('long')).toBeCloseTo(140, 4);
    expect(layout[0].tabWidths.get('busy')).toBeCloseTo(140, 4);
    expect(layout[0].tabWidths.get('short')).toBe(90);
    expect(layout[0].tabWidths.get('active')).toBe(220);
  });

  it('keeps shorter titles whole while a longer title is still full', () => {
    const layout = calculateTabStripLayout({
      groups: [layoutGroup('chats', [
        { id: 'short', width: 80 },
        { id: 'medium', width: 160 },
        { id: 'long', width: 240 },
      ], 50)],
      activeGroup: 'chats',
      availableWidth: 454,
    });

    expect(layout[0].tabWidths.get('short')).toBe(80);
    expect(layout[0].tabWidths.get('medium')).toBeCloseTo(160, 4);
    expect(layout[0].tabWidths.get('long')).toBeCloseTo(160, 4);
  });

  it('keeps busy and idle non-active tabs above their respective floors', () => {
    const layout = calculateTabStripLayout({
      groups: [layoutGroup('chats', [
        { id: 'busy', width: 220, busy: true },
        { id: 'idle', width: 80 },
      ], 50)],
      activeGroup: 'chats',
      availableWidth: 198,
    });

    expect(layout[0].tabWidths.get('busy')).toBe(110);
    expect(layout[0].tabWidths.get('idle')).toBe(36);
  });

  it('does not level the active tab with non-active tabs', () => {
    const layout = calculateTabStripLayout({
      groups: [layoutGroup('chats', [
        { id: 'active', width: 510, active: true },
        { id: 'busy', width: 250, busy: true },
        { id: 'idle', width: 200 },
      ], 50)],
      activeGroup: 'chats',
      availableWidth: 800,
    });

    expect(layout[0].tabWidths.get('active')).toBe(510);
    expect(layout[0].tabWidths.get('busy')).toBeCloseTo(118, 4);
    expect(layout[0].tabWidths.get('idle')).toBeCloseTo(118, 4);
  });

  it('switches the expanded group and compacts the previous active capsule', () => {
    const groups = [
      layoutGroup('chats', [{ id: 'chat', width: 100, active: true }]),
      layoutGroup('browser', [{ id: 'browser', width: 100 }]),
    ];
    const chatActive = calculateTabStripLayout({ groups, activeGroup: 'chats', availableWidth: 300 });
    const browserActive = calculateTabStripLayout({ groups, activeGroup: 'browser', availableWidth: 300 });

    expect(chatActive.map(group => group.presentation)).toEqual(['expanded', 'compact']);
    expect(browserActive.map(group => group.presentation)).toEqual(['compact', 'expanded']);
  });

  it('keeps a user-folded chip folded while other capsules compact automatically', () => {
    const layout = calculateTabStripLayout({
      groups: [
        { ...layoutGroup('chats', [{ id: 'chat', width: 110, active: true }]), folded: true },
        layoutGroup('browser', [{ id: 'browser', width: 90 }]),
        layoutGroup('tools', [{ id: 'tools', width: 100 }]),
      ],
      activeGroup: 'chats',
      availableWidth: 320,
    });

    expect(layout.map(group => group.presentation)).toEqual(['folded', 'compact', 'compact']);
    expect(layout[0].visibleTabIds).toEqual([]);
  });
});
