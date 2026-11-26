// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  windows: [] as any[],
  resolveOwner: vi.fn(),
  log: [] as string[],
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/qa' },
  ipcMain: { on: (channel: string, handler: (...args: any[]) => unknown) => electron.handlers.set(channel, handler) },
  BrowserWindow: class {
    visible = false;
    events = new Map<string, () => void>();
    webContents = { send: vi.fn(), once: vi.fn() };
    setBounds() {}
    constructor() {
      electron.windows.push(this);
    }
    once(event: string, callback: () => void) { this.events.set(event, callback) }
    on(event: string, callback: () => void) { this.events.set(event, callback) }
    isDestroyed() { return false }
    isVisible() { return this.visible }
    loadFile() {}
    showInactive() { this.visible = true }
    hide() {
      this.visible = false;
      electron.log.push('hide');
    }
    focus() { electron.log.push('popup focus') }
  },
}));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { log: vi.fn() } } }));
vi.mock('@pkg/window/agentWindows', () => ({ getActiveAgentWindow: vi.fn() }));
vi.mock('@pkg/window/agentWindowTrust', () => ({ agentWindowFromSender: electron.resolveOwner }));
vi.mock('@pkg/window/releaseHiddenWindow', () => ({ releaseWhenHidden: vi.fn() }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(async () => 'dark') } }));

describe('tab context menu rename', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    electron.handlers.clear();
    electron.windows.length = 0;
    electron.log.length = 0;
    electron.resolveOwner.mockReset();
    const { registerTabContextMenuIpc } = await import('@pkg/main/tabContextMenuWindow');

    registerTabContextMenuIpc();
  });

  afterEach(() => vi.useRealTimers());

  it('hides the popup and returns keyboard focus to the renderer that opened Rename Tab', async () => {
    const owner = {
      on: vi.fn(), removeListener: vi.fn(),
      isDestroyed: () => false,
      focus:       () => electron.log.push('window focus'),
      webContents: { send: vi.fn(), isDestroyed: () => false, isCrashed: () => false, on: vi.fn(), removeListener: vi.fn() },
    };
    const editor = {
      isCrashed: () => false,
      isDestroyed: () => false,
      focus:       () => electron.log.push('editor focus'),
      send:        vi.fn(() => electron.log.push('edit name')),
    };
    electron.resolveOwner.mockImplementation(sender => sender === editor ? owner : null);
    const requestId = 'rename-chat-qa';

    await electron.handlers.get('tab-context-menu:show')!({ sender: editor }, { screenX: 15, screenY: 15, items: ['rename'], requestId });
    const [popup] = electron.windows;

    await vi.advanceTimersByTimeAsync(0);
    // The popup is already clickable, but its delayed focus has not run.
    electron.handlers.get('tab-context-menu:action')!({ sender: popup.webContents }, requestId, 'rename');
    vi.runAllTimers();

    expect(electron.log).toEqual(['hide', 'window focus', 'editor focus', 'edit name']);
    expect(editor.send).toHaveBeenCalledOnce();
    expect(editor.send).toHaveBeenCalledWith('tab-context-menu:selected', requestId, 'rename');
    expect(owner.webContents.send).not.toHaveBeenCalled();
  });
});
