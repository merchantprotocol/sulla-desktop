// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { TabGroupModel } from './TabGroupModel';
import { TabGroupReveal } from './TabGroupReveal';
import { TabStripLayoutRepository, type TabStripStorage } from './TabStripLayoutRepository';

class MemoryStorage implements TabStripStorage {
  private readonly entries = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.entries.set(key, value);
  }

  getItem(key: string): string | null { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string): void { this.entries.set(key, value); }
}

describe('TabStripLayoutRepository', () => {
  it('starts with no groups for a new window and isolates storage by per-window key', () => {
    // risk: data isolation — groups from one window must not leak into another.
    const storage = new MemoryStorage();
    const main = new TabStripLayoutRepository(storage, 'window-main');
    const otherWindow = new TabStripLayoutRepository(storage, 'window-other');

    expect(main.state.value).toEqual({ version: 2, groups: [], membership: {} });
    expect(otherWindow.state.value).toEqual({ version: 2, groups: [], membership: {} });

    new TabGroupModel(main, () => 'group-main').createGroup('Main tabs', 'blue', ['tab-a']);
    expect(main.state.value.groups).toHaveLength(1);
    expect(otherWindow.state.value.groups).toEqual([]);
  });

  it('round-trips group names, theme-token colors, collapse state, order, and membership after restart', () => {
    // risk: durability — a restart must preserve the user's complete layout.
    const firstStorage = new MemoryStorage();
    const firstRepository = new TabStripLayoutRepository(firstStorage, 'window-key');
    const model = new TabGroupModel(firstRepository, (() => {
      let id = 0;
      return () => `group-${ ++id }`;
    })());
    const first = model.createGroup('  Work 🧭  ', 'gold', ['tab-a', 'tab-b']);
    const second = model.createGroup('Personal', 'purple', ['tab-c']);
    model.setCollapsed(first.id, true);
    model.reorder(second.id, 0);

    const saved = firstStorage.getItem('window-key');
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!)).toEqual({
      version: 2,
      groups: [
        { id: second.id, name: 'Personal', colorToken: 'purple', order: 0, collapsed: false },
        { id: first.id, name: 'Work 🧭', colorToken: 'gold', order: 1, collapsed: true },
      ],
      membership: { 'tab-a': first.id, 'tab-b': first.id, 'tab-c': second.id },
    });

    const restartedStorage = new MemoryStorage({ 'window-key': saved! });
    const restarted = new TabStripLayoutRepository(restartedStorage, 'window-key');

    expect(restarted.state.value).toEqual(firstRepository.state.value);
  });

  it('reveals a collapsed user group when its tab becomes active', () => {
    // risk: data accuracy — a selected tab must not remain hidden in a collapsed group.
    const repository = new TabStripLayoutRepository(new MemoryStorage(), 'window-key');
    const model = new TabGroupModel(repository, () => 'active-group');
    const group = model.createGroup('Selected', 'blue', ['browser-tab']);
    const reveal = new TabGroupReveal(model);

    model.setCollapsed(group.id, true);
    reveal.select({ id: 'browser-tab' });

    expect(model.groups[0].collapsed).toBe(false);
  });

  it('loads legacy folded-ID arrays as no groups and ignores malformed or unsupported data', () => {
    // risk: durability — legacy and corrupt storage must not break startup.
    const legacy = new TabStripLayoutRepository(new MemoryStorage({ legacy: '["tools"]' }), 'legacy');
    const malformed = new TabStripLayoutRepository(new MemoryStorage({ malformed: '{' }), 'malformed');
    const unsupported = new TabStripLayoutRepository(new MemoryStorage({ unsupported: '{"version":1,"groups":[],"membership":{}}' }), 'unsupported');

    expect(legacy.state.value).toEqual({ version: 2, groups: [], membership: {} });
    expect(malformed.state.value).toEqual({ version: 2, groups: [], membership: {} });
    expect(unsupported.state.value).toEqual({ version: 2, groups: [], membership: {} });
  });

  it('preserves optional empty names and sanitizes invalid groups and stale membership', () => {
    // risk: durability/data integrity — blank names persist, while malformed records and stale memberships are discarded.
    const raw = JSON.stringify({
      version: 2,
      groups: [
        { id: 'usable', name: '  Valid  ', colorToken: 'orange', order: 4, collapsed: true },
        { id: 'empty-name', name: ' ', colorToken: 'blue', order: 1, collapsed: false },
        { id: 'missing-name', colorToken: 'green', order: 2, collapsed: false },
        { id: 'unknown-color', name: 'Invalid', colorToken: '#ff00ff', order: 2, collapsed: false },
      ],
      membership: { 'live-tab': 'usable', 'blank-name-tab': 'empty-name', 'missing-name-tab': 'missing-name', 'stale-group': 'absent' },
    });
    const repository = new TabStripLayoutRepository(new MemoryStorage({ state: raw }), 'state');

    expect(repository.state.value.groups).toEqual([
      { id: 'empty-name', name: '', colorToken: 'blue', order: 0, collapsed: false },
      { id: 'usable', name: 'Valid', colorToken: 'orange', order: 1, collapsed: true },
    ]);
    expect(repository.state.value.membership).toEqual({ 'live-tab': 'usable', 'blank-name-tab': 'empty-name' });
  });
});
