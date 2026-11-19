// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Electron from 'electron';

import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';
import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';
import { InternalTabViewManager } from '@pkg/window/internalTabViewManager';

/** IPC boundary for isolated internal-tab renderers. */
export class InternalTabViewIpc implements MainProcessIpcStep {
  readonly name = 'internal-tab-views';

  async register({ ipc }: MainProcessIpcContext): Promise<void> {
    const manager = InternalTabViewManager.getInstance();
    const owner = (event: Electron.IpcMainInvokeEvent): Electron.BrowserWindow => {
      const win = agentWindowFromSender(event.sender);
      if (!win || win.isDestroyed()) throw new Error('Untrusted internal tab caller');
      return win;
    };
    ipc.handle('internal-tab-view:activate', (event: Electron.IpcMainInvokeEvent, tabId: string, windowKey: string, bounds: Electron.Rectangle, descriptor?: unknown) => manager.activate(owner(event), tabId, windowKey, bounds, descriptor));
    ipc.handle('internal-tab-view:chrome-ready', (event: Electron.IpcMainInvokeEvent) => manager.markChromeReady(owner(event)));
    ipc.handle('internal-tab-view:bounds', (event: Electron.IpcMainInvokeEvent, tabId: string, bounds: Electron.Rectangle) => manager.setBounds(owner(event), tabId, bounds));
    ipc.handle('internal-tab-view:visible', (event: Electron.IpcMainInvokeEvent, tabId: string, visible: boolean) => manager.setVisible(owner(event), tabId, visible));
    ipc.handle('internal-tab-view:close', (event: Electron.IpcMainInvokeEvent, tabId: string) => manager.destroy(owner(event), tabId));
    ipc.handle('internal-tab-view:reload', (event: Electron.IpcMainInvokeEvent, tabId: string) => manager.reload(owner(event), tabId));
    ipc.handle('internal-tab-view:open-workspace-tab', (event: Electron.IpcMainInvokeEvent, request: unknown) => {
      manager.openWorkspaceTab(event.sender, request);
    });
    Electron.ipcMain.on('internal-tab-view:chat-running', (event: Electron.IpcMainEvent, tabId: string, running: boolean) => {
      if (typeof running === 'boolean') manager.notifyChatRunning(event.sender, tabId, running);
    });
    // One-way renderer updates need ipcMain.on; the proxy registrar only guarantees handle().
    // A host renderer reads its own tab synchronously at boot, before it builds its tab list.
    Electron.ipcMain.on('internal-tab-view:descriptor', (event: Electron.IpcMainEvent, tabId: string) => {
      event.returnValue = manager.descriptorFor(event.sender, tabId);
    });
    Electron.ipcMain.on('internal-tab-view:update', (event: Electron.IpcMainEvent, tabId: string, descriptor: unknown) => manager.notifyTabUpdate(event.sender, tabId, descriptor));
  }
}
