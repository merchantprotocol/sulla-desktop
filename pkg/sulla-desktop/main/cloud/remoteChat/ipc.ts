// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow, ipcMain, powerMonitor, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { RemoteChatViewer } from './RemoteChatViewer';

export function initRemoteChatViewerIpc(): void {
  const trusted = (event: IpcMainInvokeEvent) => !!BrowserWindow.fromWebContents(event.sender)
    && event.senderFrame === event.sender.mainFrame && /^(file:|app:)/.test(event.senderFrame?.url ?? '');
  const windows = new Set<WebContents>();
  const viewer = new RemoteChatViewer(frame => {
    for (const window of windows) {
      if (!window.isDestroyed() && /^(file:|app:)/.test(window.getURL())) window.send('remote-chat:frame', frame);
    }
  });
  ipcMain.handle('remote-chat:connect', async (event, bound: unknown) => {
    if (!trusted(event)) return null;
    if (!windows.has(event.sender)) {
      const sender = event.sender;
      windows.add(sender);
      sender.once('destroyed', () => {
        windows.delete(sender);
        if (!windows.size) viewer.reset(true);
      });
    }
    await viewer.connect(bound === true);
    return viewer.context();
  });
  ipcMain.handle('remote-chat:send', (event, command: unknown) =>
    trusted(event) && windows.has(event.sender) ? viewer.send(command) : false);
  ipcMain.handle('remote-chat:history', (event, thread: unknown, cursor: unknown, ids: unknown, reconcileOnly: unknown) =>
    trusted(event) && windows.has(event.sender) ? viewer.history(thread, cursor, ids, reconcileOnly) : { status: 403 });
  ipcMain.handle('remote-chat:check-identity', event =>
    trusted(event) && windows.has(event.sender) ? viewer.checkIdentity().then(() => undefined) : undefined);
  powerMonitor.on('suspend', () => viewer.reset());
  powerMonitor.on('resume', () => { if (windows.size) void viewer.connect().catch(() => undefined) });
}
