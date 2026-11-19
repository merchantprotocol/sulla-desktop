// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { TabTransferService } from './TabTransferService';

class FakeIpc {
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  on(channel: string, listener: (...args: any[]) => void) { this.listeners.set(channel, [...(this.listeners.get(channel) || []), listener]); return this; }
  removeListener(channel: string, listener: (...args: any[]) => void) { this.listeners.set(channel, (this.listeners.get(channel) || []).filter(candidate => candidate !== listener)); return this; }
  emit(channel: string, ...args: any[]) { for (const listener of this.listeners.get(channel) || []) listener(...args); }
}

/** Minimal WebContents stand-in: send plus the once/destroy pair the service relies on. */
class FakeWebContents {
  destroyedListeners: Array<() => void> = [];
  constructor(public id: number, private readonly onSend: (channel: string, ...args: any[]) => void) {}
  send(channel: string, ...args: any[]) { this.onSend(channel, ...args); }
  once(channel: string, listener: () => void) { if (channel === 'destroyed') this.destroyedListeners.push(listener); return this; }
  destroy() { for (const listener of this.destroyedListeners.splice(0)) listener(); }
}

class FakeWindow {
  closedListeners: Array<() => void> = [];
  id: number;
  bounds: Electron.Rectangle;
  isFocused = () => false;
  isDestroyed = () => false;
  isVisible = () => true;
  actions: string[];
  webContents: FakeWebContents;
  constructor(id: number, actions: string[], bounds = { x: 0, y: 0, width: 800, height: 600 }, ipc?: FakeIpc) {
    this.id = id; this.bounds = bounds; this.actions = actions;
    this.webContents = new FakeWebContents(id, (channel: string, ...args: any[]) => {
      actions.push(channel);
      if (channel === 'tabs:release') ipc?.emit('tabs:transfer-released', { sender: this.webContents }, args[0], args[1]);
      if (channel === 'tabs:adopt') ipc?.emit('tabs:transfer-adopted', { sender: this.webContents }, args[0], args[1].id);
    });
  }
  getBounds() { return this.bounds; }
  setBounds(bounds: Electron.Rectangle) { this.bounds = bounds; this.actions.push('move-window'); }
  once(channel: string, listener: () => void) { if (channel === 'closed') this.closedListeners.push(listener); return this; }
  close() { for (const listener of this.closedListeners.splice(0)) listener(); }
}

describe('TabTransferService', () => {
  it('forgets renderer readiness when a window closes', () => {
    // risk: stale BrowserWindow ids prevent a replacement window from awaiting renderer readiness
    const ipc = new FakeIpc(); const actions: string[] = [];
    const win = new FakeWindow(44, actions, undefined, ipc);
    const service = new TabTransferService(ipc as any, { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } as any, () => win as any, () => [win] as any, () => win as any, {} as any);
    service.install();
    ipc.emit('tabs:transfer-ready', { sender: win.webContents });
    expect((service as any).readyWindows.has(win.id)).toBe(true);
    win.close();
    expect((service as any).readyWindows.has(win.id)).toBe(false);
  });
  it('releases before adopting, then moves the existing native view and finalizes an empty source', async() => {
    // risk: chat state and native browser-session continuity during cross-window transfer
    const ipc = new FakeIpc(); const actions: string[] = [];
    const source = new FakeWindow(1, actions, { x: 0, y: 0, width: 800, height: 600 }, ipc);
    const target = new FakeWindow(2, actions, { x: 800, y: 0, width: 800, height: 600 }, ipc);
    const views = { ownsTab: () => true, markTransferring: (id: string, flag: boolean) => actions.push(`transferring:${ flag }`), moveViewToWindow: () => { actions.push('move-view'); return true; } } as any;
    // Map by sender so the target's ready signal marks the target (not the source) as ready.
    const agentWindowFor = (wc: Electron.WebContents) => (wc === target.webContents ? target : wc === source.webContents ? source : null);
    const service = new TabTransferService(ipc as any, { getCursorScreenPoint: () => ({ x: 900, y: 100 }) } as any, agentWindowFor as any, () => [source, target] as any, () => target as any, views);
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

  it('registers the destroyed cleanup once per sender across repeated drags', () => {
    // risk: listener leak on long-lived agent windows (one drag-start per tab drag)
    const ipc = new FakeIpc(); const actions: string[] = [];
    const source = new FakeWindow(1, actions, { x: 0, y: 0, width: 800, height: 600 }, ipc);
    const views = { ownsTab: () => true, markTransferring: () => {}, moveViewToWindow: () => true } as any;
    const service = new TabTransferService(ipc as any, { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } as any, () => source as any, () => [source] as any, () => source as any, views);
    service.install();
    ipc.emit('tabs:drag-start', { sender: source.webContents }, { tabId: 'tab-1', descriptor: { id: 'tab-1' }, tabCount: 2 });
    ipc.emit('tabs:drag-start', { sender: source.webContents }, { tabId: 'tab-2', descriptor: { id: 'tab-2' }, tabCount: 2 });
    expect(source.webContents.destroyedListeners).toHaveLength(1);

    // once the sender is destroyed, the next drag from a fresh sender with the same id registers again
    source.webContents.destroy();
    ipc.emit('tabs:drag-start', { sender: source.webContents }, { tabId: 'tab-3', descriptor: { id: 'tab-3' }, tabCount: 2 });
    expect(source.webContents.destroyedListeners).toHaveLength(1);
  });

  it('opens a new window for an outside drop, including the source window\'s only tab', async() => {
    // risk: a one-tab tear-off must preserve tab ownership and close the emptied source
    const ipc = new FakeIpc(); const actions: string[] = [];
    const source = new FakeWindow(1, actions, { x: 0, y: 0, width: 800, height: 600 }, ipc);
    let windows = [source]; let opened = 0;
    const target = new FakeWindow(2, actions, undefined, ipc);
    const views = { ownsTab: () => true, markTransferring: () => {}, moveViewToWindow: () => true } as any;
    const service = new TabTransferService(ipc as any, { getCursorScreenPoint: () => ({ x: 2000, y: 1000 }) } as any, () => source as any, () => windows as any, () => { opened++; windows = [source, target]; ipc.emit('tabs:transfer-ready', { sender: target.webContents }); return target as any; }, views);
    service.install();
    ipc.emit('tabs:drag-start', { sender: source.webContents }, { tabId: 'tab-a', descriptor: { id: 'tab-a' }, tabCount: 1 });
    ipc.emit('tabs:drag-end', { sender: source.webContents }, { tabId: 'tab-a', screenX: 2000, screenY: 1000 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened).toBe(1);
    expect(actions).toContain('tabs:release');
    expect(actions).toContain('tabs:adopt');
    expect(actions).toContain('tabs:release-finalize');
    expect(actions).not.toContain('move-window');
  });
});
