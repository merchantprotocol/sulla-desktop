// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { TabTransferService } from './TabTransferService';

class FakeIpc {
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  on(channel: string, listener: (...args: any[]) => void) { this.listeners.set(channel, [...(this.listeners.get(channel) || []), listener]); return this; }
  removeListener(channel: string, listener: (...args: any[]) => void) { this.listeners.set(channel, (this.listeners.get(channel) || []).filter(candidate => candidate !== listener)); return this; }
  emit(channel: string, ...args: any[]) { for (const listener of this.listeners.get(channel) || []) listener(...args); }
}

class FakeWindow {
  id: number;
  bounds: Electron.Rectangle;
  isFocused = () => false;
  isDestroyed = () => false;
  isVisible = () => true;
  actions: string[];
  webContents: any;
  constructor(id: number, actions: string[], bounds = { x: 0, y: 0, width: 800, height: 600 }, ipc?: FakeIpc) {
    this.id = id; this.bounds = bounds; this.actions = actions;
    this.webContents = { id, send: (channel: string, ...args: any[]) => {
      actions.push(channel);
      if (channel === 'tabs:release') ipc?.emit('tabs:transfer-released', { sender: this.webContents }, args[0], args[1]);
      if (channel === 'tabs:adopt') ipc?.emit('tabs:transfer-adopted', { sender: this.webContents }, args[0], args[1].id);
    } };
  }
  getBounds() { return this.bounds; }
  setBounds(bounds: Electron.Rectangle) { this.bounds = bounds; this.actions.push('move-window'); }
}

describe('TabTransferService', () => {
  it('releases before adopting, then moves the existing native view and finalizes an empty source', async() => {
    // risk: chat state and native browser-session continuity during cross-window transfer
    const ipc = new FakeIpc(); const actions: string[] = [];
    const source = new FakeWindow(1, actions, { x: 0, y: 0, width: 800, height: 600 }, ipc);
    const target = new FakeWindow(2, actions, { x: 800, y: 0, width: 800, height: 600 }, ipc);
    const views = { ownsTab: () => true, markTransferring: (id: string, flag: boolean) => actions.push(`transferring:${ flag }`), moveViewToWindow: () => { actions.push('move-view'); return true; } } as any;
    const service = new TabTransferService(ipc as any, { getCursorScreenPoint: () => ({ x: 900, y: 100 }) } as any, () => source as any, () => [source, target] as any, () => target as any, views);
    service.install();
    ipc.emit('tabs:transfer-ready', { sender: target.webContents });
    ipc.emit('tabs:drag-start', { sender: source.webContents }, { tabId: 'tab-1', descriptor: { id: 'tab-1', mode: 'chat' }, tabCount: 2 });
    ipc.emit('tabs:drag-end', { sender: source.webContents }, { tabId: 'tab-1', screenX: 900, screenY: 100 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(actions.indexOf('tabs:release')).toBeLessThan(actions.indexOf('tabs:adopt'));
    expect(actions.indexOf('tabs:adopt')).toBeLessThan(actions.indexOf('move-view'));
    expect(actions).toContain('tabs:release-finalize');
    expect(actions).not.toContain('conversation-history:close');
    expect(actions).not.toContain('chat:stop');
  });

  it('opens a new window for an outside multi-tab drop but moves a single-tab source window', async() => {
    // risk: tab ownership and window geometry at drag-drop boundaries
    const ipc = new FakeIpc(); const actions: string[] = [];
    const source = new FakeWindow(1, actions, { x: 0, y: 0, width: 800, height: 600 }, ipc);
    let windows = [source]; let opened = 0;
    const target = new FakeWindow(2, actions, undefined, ipc);
    const views = { ownsTab: () => true, markTransferring: () => {}, moveViewToWindow: () => true } as any;
    const service = new TabTransferService(ipc as any, { getCursorScreenPoint: () => ({ x: 2000, y: 1000 }) } as any, () => source as any, () => windows as any, () => { opened++; windows = [source, target]; ipc.emit('tabs:transfer-ready', { sender: target.webContents }); return target as any; }, views);
    service.install();
    ipc.emit('tabs:drag-start', { sender: source.webContents }, { tabId: 'tab-a', descriptor: { id: 'tab-a' }, tabCount: 2 });
    ipc.emit('tabs:drag-end', { sender: source.webContents }, { tabId: 'tab-a', screenX: 2000, screenY: 1000 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened).toBe(1);

    const oneTabService = new TabTransferService(ipc as any, { getCursorScreenPoint: () => ({ x: 2000, y: 1000 }) } as any, () => source as any, () => [source] as any, () => target as any, views);
    oneTabService.install();
    ipc.emit('tabs:drag-start', { sender: source.webContents }, { tabId: 'tab-b', descriptor: { id: 'tab-b' }, tabCount: 1 });
    ipc.emit('tabs:drag-end', { sender: source.webContents }, { tabId: 'tab-b', screenX: 2000, screenY: 1000 });
    expect(source.bounds.x).toBe(1600);
  });
});
