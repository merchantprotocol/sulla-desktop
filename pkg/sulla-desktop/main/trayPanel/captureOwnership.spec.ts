// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  handlers: new Map<string, (...args:any[]) => Promise<unknown>>(),
  windows: [] as Array<{ webContents:{ mainFrame:{ url:string } }; isDestroyed:() => boolean }>,
  capture: vi.fn(),
  clipboard: vi.fn(),
  dialog: vi.fn(),
  directory: '',
}));

vi.mock('electron', async() => {
  const { EventEmitter } = await import('node:events');
  const { pathToFileURL } = await import('node:url');

  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, send: vi.fn() });
    constructor() { super(); ports.windows.push(this) }
    async loadFile(file:string) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed() { return this.destroyed }
    hide() {}
    destroy() { this.destroyed = true; this.emit('closed') }
  }

  return {
    BrowserWindow: Window,
    app: { getAppPath: () => '/app', getPath: () => path.join(ports.directory, 'missing-downloads') },
    clipboard: { writeText: ports.clipboard },
    desktopCapturer: {},
    dialog: { showSaveDialog: ports.dialog },
    globalShortcut: { isRegistered: () => false, register: () => true, unregister: () => undefined },
    ipcMain: { handle: (name:string, handler:(...args:any[]) => Promise<unknown>) => ports.handlers.set(name, handler), on: vi.fn() },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800 } }) },
    shell: {},
  };
});

vi.mock('@pkg/main/sullaFilesCapture', async importOriginal => {
  const original = await importOriginal<typeof import('../sullaFilesCapture')>();
  return { ...original, getSullaFilesCaptureService: () => ({ trayScreenshot: ports.capture }) };
});
vi.mock('@pkg/main/sullaFilesWatcher', () => ({ getSullaFilesWatcher: () => ({ folder: path.join(ports.directory, 'missing-files') }) }));
vi.mock('@pkg/main/sullaFilesLinkService', () => ({ getSullaFilesLinkService: vi.fn(), SharingUnavailableError: Error }));
vi.mock('@pkg/main/sullaFilesChatImport', () => ({ importChatFiles: vi.fn() }));
vi.mock('@pkg/main/captureStudioRpc', () => ({ callCaptureStudio: vi.fn(), getCaptureStudioRecordingState: vi.fn(), isCaptureStudioReady: vi.fn() }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {} }));
vi.mock('@pkg/main/mainEvents', () => ({ default: {} }));
vi.mock('@pkg/main/update/UpdateManager', () => ({ updateManager: {} }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: console } }));
vi.mock('@pkg/utils/screenRecordingPermission', () => ({ ScreenRecordingPermission: class {} }));
vi.mock('@pkg/window', () => ({ openDocker: vi.fn(), openUrlInApp: vi.fn() }));
vi.mock('@pkg/window/agentWindows', () => ({ ensureAgentWindow: vi.fn() }));
vi.mock('@pkg/window/supportCenter', () => ({ openSupportCenter: vi.fn() }));

import { createTrayPanel, destroyTrayPanel } from '../trayPanel';

// risk: data exposure and lost capture ownership across a native dialog.
it('binds the actual main IPC save handler to the current popup frame and ignores renderer paths', async() => {
  ports.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-owner-spec-'));
  const bytes = Buffer.from([0, 12, 255]);
  ports.capture.mockImplementation(async() => ({ name: 'shot.png', bytes }));
  const actual = path.join(ports.directory, 'chosen.png');
  const injected = path.join(ports.directory, 'renderer.png');
  const stale = path.join(ports.directory, 'stale.png');

  try {
    createTrayPanel();
    const eventFor = ({ webContents }:typeof ports.windows[number]) => ({ sender: webContents, senderFrame: webContents.mainFrame });
    const tray = eventFor(ports.windows[0]);
    const take = ports.handlers.get('tray-panel:capture-screenshot')!;
    const save = ports.handlers.get('tray-panel:copy-capture-path')!;
    await take(tray, 'full');
    const first = eventFor(ports.windows[1]);

    await expect(save(tray, { path: injected })).rejects.toThrow('does not own');
    await expect(save({ ...first, senderFrame: { url: first.senderFrame.url } }, { path: injected })).rejects.toThrow('does not own');
    expect(ports.dialog).not.toHaveBeenCalled();

    ports.dialog.mockImplementationOnce(async() => {
      await take(tray, 'full');
      return { canceled: false, filePath: stale };
    });
    await expect(save(first)).resolves.toBeUndefined();
    await expect(save(first)).rejects.toThrow('does not own');
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ports.clipboard).not.toHaveBeenCalled();

    ports.dialog.mockResolvedValueOnce({ canceled: false, filePath: actual });
    const second = eventFor(ports.windows[2]);
    await expect(save(second, { path: injected, relativePath: injected })).resolves.toBe(actual);
    expect(await fs.readFile(actual)).toEqual(bytes);
    await expect(fs.stat(injected)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ports.clipboard.mock.calls).toEqual([[actual]]);
  } finally {
    destroyTrayPanel();
    await fs.rm(ports.directory, { recursive: true, force: true });
  }
});
