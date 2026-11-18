// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const windows = new Map<number, FakeWindow>();
class FakeWindow {
  listeners = new Map<string, Function[]>();
  focused = false;
  dead = false;
  constructor(public id: number) { windows.set(id, this); }
  on(event: string, callback: Function) { this.listeners.set(event, [...(this.listeners.get(event) || []), callback]); }
  show() {}
  focus() { this.focused = true; }
  isFocused() { return this.focused; }
  isDestroyed() { return this.dead; }
  getContentView() { return { children: [] }; }
  getWebContents() { return { id: this.id }; }
  close(event: string) { this.listeners.get(event)?.forEach(fn => fn()); }
}
vi.mock('electron', () => ({ BrowserWindow: { fromId: (id: number) => windows.get(id) || null, fromWebContents: () => null } }));
import { AgentWindowRegistry, initialTabsQuery, setAgentWindowMapping } from './agentWindows';

describe('AgentWindowRegistry', () => {
  beforeEach(() => windows.clear());
  it('prefers focused, then most recently focused alive agent window', () => {
    const registry = new AgentWindowRegistry();
    const mappings: Record<string, number> = {};
    // The registry receives the shared map through setAgentWindowMapping.
    setAgentWindowMapping(mappings);
    const create = (name: string) => new FakeWindow(windows.size + 1) as any;
    const first = registry.openAgentWindow(create, { windowKey: 'main' }) as any as FakeWindow;
    const second = registry.openAgentWindow(create, { windowKey: 'other' }) as any as FakeWindow;
    first.focused = false; second.focused = false;
    first.listeners.get('focus')?.forEach(fn => fn());
    second.listeners.get('focus')?.forEach(fn => fn());
    expect(registry.getActiveAgentWindow()?.id).toBe(second.id);
    first.focused = true;
    expect(registry.getActiveAgentWindow()?.id).toBe(first.id);
  });

  it('moves the main-agent alias to the most recently focused remaining window when main closes', () => {
    const registry = new AgentWindowRegistry();
    const mappings: Record<string, number> = {};
    setAgentWindowMapping(mappings);
    const create = (name: string) => new FakeWindow(windows.size + 1) as any;
    const main = registry.openAgentWindow(create, { windowKey: 'main' }) as any as FakeWindow;
    const second = registry.openAgentWindow(create, { windowKey: 'other' }) as any as FakeWindow;
    second.listeners.get('focus')?.forEach(fn => fn());
    main.close('closed');
    expect(mappings['main-agent']).toBe(second.id);
  });
});

describe('initial agent-window tabs', () => {
  it('keeps restored tabs, starts fresh-chat windows clean, and leaves adopt windows empty', () => {
    expect(initialTabsQuery('restore', false)).toBe('');
    expect(initialTabsQuery('fresh-chat', false)).toBe('&freshAgentTab=1');
    expect(initialTabsQuery('adopt', false)).toBe('&adoptPending=1');
    expect(initialTabsQuery('fresh-chat', true)).toBe('');
  });
});
