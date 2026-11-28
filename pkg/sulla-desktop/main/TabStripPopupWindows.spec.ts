// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabContextMenuRequest, TabGroupPopoverRequest } from '@pkg/shared/TabStripPopup';

const electron = vi.hoisted(() => ({
  getTheme: vi.fn(),
  screen:   { getDisplayNearestPoint: vi.fn() },
}));
const ipcMain = new EventEmitter();
const popups: FakeWindow[] = [];
let nextId = 1;

class FakeContents extends EventEmitter {
  send = vi.fn();
  isDestroyed = () => this.owner.destroyed;
  isCrashed = () => this.crashed;
  getZoomFactor = () => 1;
  crashed = false;

  constructor(readonly owner: FakeWindow) {
    super();
  }
}

class FakeWindow extends EventEmitter {
  readonly id = nextId++;
  readonly webContents = new FakeContents(this);
  visible = false;
  destroyed = false;
  setBounds = vi.fn();
  setIgnoreMouseEvents = vi.fn();
  loadFile = async() => {};
  isVisible = () => this.visible;
  isDestroyed = () => this.destroyed;
  isFocused = () => this.visible;
  getContentBounds = () => ({ x: 0, y: 0 });
  focus = () => {};
  showInactive = () => {
    this.visible = true;
    this.emit('show');
  };

  hide = () => {
    this.visible = false;
    this.emit('hide');
  };

  constructor(popup = false) {
    super();
    if (popup) popups.push(this);
  }

  destroy(): void {
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class extends FakeWindow { constructor() { super(true) } },
  ipcMain,
  screen:        electron.screen,
  app:           { getAppPath: () => '/app', isPackaged: false },
}));
vi.mock('@pkg/window/agentWindowTrust', () => ({ agentWindowFromSender: (sender: FakeContents) => sender.owner }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: electron.getTheme } }));

function emit(channel: string, sender: FakeWindow, ...args: unknown[]): void {
  ipcMain.emit(channel, { sender: sender.webContents }, ...args);
}

function openMenu(owner: FakeWindow, requestId: string): void {
  const request: TabContextMenuRequest = { requestId, screenX: 0, screenY: 20, items: ['close'] };

  emit('tab-context-menu:show', owner, request);
}

function opener(): FakeWindow {
  const owner = new FakeWindow();

  owner.showInactive();
  return owner;
}

describe('native tab strip popups', () => {
  beforeEach(async() => {
    vi.useFakeTimers();
    electron.getTheme.mockReset().mockResolvedValue('protocol-dark');
    electron.screen.getDisplayNearestPoint.mockReset().mockReturnValue({ workArea: { x: 0, y: 0, width: 800, height: 600 } });
    const { registerTabContextMenuIpc } = await import('./tabContextMenuWindow');

    registerTabContextMenuIpc();
  });
  afterEach(() => {
    ipcMain.removeAllListeners();
    for (const popup of popups.splice(0)) if (!popup.destroyed) popup.destroy();
    vi.useRealTimers();
  });

  it('ignores a stale action and Escape until the replacement request renders', async() => {
    const first = opener();
    const second = opener();

    openMenu(first, 'first');
    await vi.advanceTimersByTimeAsync(0);
    const [popup] = popups;

    let finishTheme!: (theme: string) => void;

    electron.getTheme.mockImplementationOnce(() => new Promise(resolve => { finishTheme = resolve }));
    openMenu(second, 'second');
    await vi.advanceTimersByTimeAsync(0);
    emit('tab-context-menu:action', popup, 'first', 'close');
    emit('tab-context-menu:action', popup, 'second', 'close');
    emit('tab-context-menu:dismiss', popup, 'first');
    expect(second.webContents.send).not.toHaveBeenCalled();
    finishTheme('protocol-dark');
    await vi.advanceTimersByTimeAsync(0);

    emit('tab-context-menu:action', popup, 'first', 'close');
    emit('tab-context-menu:dismiss', popup, 'first');
    expect(popup.visible).toBe(true);
    emit('tab-context-menu:action', popup, 'second', 'close');
    emit('tab-context-menu:action', popup, 'second', 'close');
    expect(second.webContents.send).toHaveBeenCalledExactlyOnceWith('tab-context-menu:selected', 'second', 'close');
    expect(popup.visible).toBe(false);
  });

  it('allows adding a tab only to a group present in the active menu request', async() => {
    // risk: permissions — renderer actions cannot target groups omitted from the active menu.
    const owner = opener();
    const request: TabContextMenuRequest = {
      requestId: 'group-menu', screenX: 40, screenY: 20, items: ['addToGroup'],
      groups: [{ id: 'group-1', name: 'Launch', colorToken: 'blue', color: '#123456' }],
    };

    emit('tab-context-menu:show', owner, request);
    await vi.advanceTimersByTimeAsync(0);
    const popup = popups[0];

    emit('tab-context-menu:action', popup, request.requestId, 'joinGroup:unknown');
    expect(owner.webContents.send).not.toHaveBeenCalled();
    emit('tab-context-menu:action', popup, request.requestId, 'joinGroup:group-1');
    expect(owner.webContents.send).toHaveBeenCalledExactlyOnceWith('tab-context-menu:selected', request.requestId, 'joinGroup:group-1');
  });

  it.each(['navigation', 'crash', 'close'])('hides the current menu on opener %s and detaches the previous opener', async(event) => {
    const first = opener();
    const second = opener();

    openMenu(first, 'first');
    await vi.advanceTimersByTimeAsync(0);
    openMenu(second, 'second');
    await vi.advanceTimersByTimeAsync(0);
    const [popup] = popups;

    expect(first.webContents.listenerCount('did-start-navigation')).toBe(0);
    expect(first.webContents.listenerCount('render-process-gone')).toBe(0);
    expect(first.listenerCount('closed')).toBe(0);
    first.destroy();
    expect(popup.visible).toBe(true);
    second.webContents.send.mockImplementation(() => expect(popup.visible).toBe(false));

    if (event === 'navigation') {
      second.webContents.emit('did-start-navigation', { isMainFrame: false });
      expect(popup.visible).toBe(true);
      second.webContents.emit('did-start-navigation', { isMainFrame: true });
      expect(second.webContents.send).toHaveBeenCalledExactlyOnceWith('tab-context-menu:closed', 'second');
    } else {
      if (event === 'crash') second.webContents.emit('render-process-gone');
      else second.destroy();
      expect(second.webContents.send).not.toHaveBeenCalled();
    }
    expect(popup.visible).toBe(false);
    expect(second.webContents.listenerCount('did-start-navigation')).toBe(0);
    expect(second.webContents.listenerCount('render-process-gone')).toBe(0);
    expect(second.listenerCount('closed')).toBe(0);
  });

  it('accepts group edits only from the active popover and forwards allowed changes to its opener', async() => {
    // risk: permissions — only the active native popup may mutate its opener's group.
    // risk: data accuracy — group names accept 60 characters and reject longer input.
    const owner = opener();
    const request: TabGroupPopoverRequest = {
      requestId: 'group-edit', groupId: 'group-1', name: 'x'.repeat(60), colorToken: 'blue', focus: 'name',
      anchor: { x: 20, y: 45, aboveY: 5 }, palette: {},
      swatches: ['grey', 'blue', 'cyan', 'green', 'gold', 'orange', 'pink', 'purple'].map(token => ({ token, label: token, color: '#123456' })),
    };

    emit('tab-group-popover:show', owner, request);
    await vi.advanceTimersByTimeAsync(0);
    const popup = popups[0];
    const otherWindow = new FakeWindow();

    emit('tab-group-popover:change', otherWindow, request.requestId, { name: 'Not from the popover' });
    emit('tab-group-popover:change', popup, request.requestId, { name: 'x'.repeat(61) });
    emit('tab-group-popover:change', popup, request.requestId, { name: 'x'.repeat(60) });
    emit('tab-group-popover:change', popup, request.requestId, { colorToken: 'unlisted-color' });
    expect(owner.webContents.send).toHaveBeenCalledExactlyOnceWith('tab-group-popover:changed', request.requestId, { name: 'x'.repeat(60) });

    emit('tab-group-popover:done', popup, request.requestId);
    expect(owner.webContents.send.mock.calls.filter(([channel]) => channel === 'tab-group-popover:closed')).toHaveLength(1);
    expect(owner.webContents.send).toHaveBeenLastCalledWith('tab-group-popover:closed', request.requestId);
    expect(popup.visible).toBe(false);
  });

});
