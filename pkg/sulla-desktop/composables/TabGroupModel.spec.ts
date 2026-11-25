// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { TabGroupModel } from './TabGroupModel';

describe('TabGroupModel', () => {
  const model = new TabGroupModel();

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

  it('counts only needs-you and stalled tabs', () => {
    expect(model.needsYouCount([
      { activity: 'working' }, { activity: 'waiting' }, { activity: 'you' }, { activity: 'stalled' }, { activity: 'idle' },
    ])).toBe(2);
  });
});
