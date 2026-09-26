/**
 * @jest-environment node
 */
import { EventEmitter } from 'events';

import { describe, expect, it, jest } from '@jest/globals';

const browserSession = { id: 'persist:sulla-browser' };
const appSession = { id: 'default' };

jest.unstable_mockModule('electron', () => ({
  default: {
    ipcMain: new EventEmitter(),
    session: { fromPartition: () => browserSession },
  },
  session: { fromPartition: () => browserSession },
}));

/** Minimal ipcMain double: on/once/etc. from EventEmitter + handle/invoke. */
function makeIpcMain() {
  const emitter: any = new EventEmitter();
  const handlers = new Map<string, (...args: any[]) => any>();
  emitter.handle = (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn);
  emitter.handleOnce = emitter.handle;
  emitter.invoke = (channel: string, event: any, ...args: any[]) => handlers.get(channel)!(event, ...args);

  return emitter;
}

const guest = { sender: { session: browserSession, getURL: () => 'https://evil.example/' } };
const app = { sender: { session: appSession } };

describe('ipcGuestGuard', () => {
  it('blocks web content from privileged invoke channels but not Sulla windows', async() => {
    const { isIpcAllowed } = await import('../ipcGuestGuard');

    expect(isIpcAllowed(guest, 'vault:read-account', [])).toBe(false);
    expect(isIpcAllowed(guest, 'chrome-api:cookies:getAll', [])).toBe(false);
    expect(isIpcAllowed(guest, 'browser-tab-view:exec-js', [])).toBe(false);
    expect(isIpcAllowed(app, 'vault:read-account', [])).toBe(true);
  });

  it('lets web content read only the theme setting', async() => {
    const { isIpcAllowed } = await import('../ipcGuestGuard');

    expect(isIpcAllowed(guest, 'sulla-settings-get', ['theme'])).toBe(true);
    expect(isIpcAllowed(guest, 'sulla-settings-get', ['claudeOAuthToken'])).toBe(false);
    expect(isIpcAllowed(guest, 'browser-tab-view:bridge-event', [{ type: 'x' }])).toBe(true);
  });

  it('wraps handlers and listeners on an ipcMain and keeps removeListener working', async() => {
    // Each module load self-installs once on the mocked global ipcMain; a
    // fresh load therefore has `installed` set — reset and install on a double.
    jest.resetModules();
    const ipc = makeIpcMain();
    const electron: any = (await import('electron')).default;
    electron.ipcMain = ipc;
    await import('../ipcGuestGuard');

    const secret = jest.fn(() => 'secret');
    ipc.handle('vault:read-account', secret);
    await expect(Promise.resolve().then(() => ipc.invoke('vault:read-account', guest))).rejects.toThrow('not available to web content');
    expect(secret).not.toHaveBeenCalled();
    expect(ipc.invoke('vault:read-account', app)).toBe('secret');

    const listener = jest.fn();
    ipc.on('conversation-history:record', listener);
    ipc.emit('conversation-history:record', guest, {});
    expect(listener).not.toHaveBeenCalled();
    ipc.emit('conversation-history:record', app, {});
    expect(listener).toHaveBeenCalledTimes(1);

    ipc.removeListener('conversation-history:record', listener);
    ipc.emit('conversation-history:record', app, {});
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ipc.listenerCount('conversation-history:record')).toBe(0);
  });
});
