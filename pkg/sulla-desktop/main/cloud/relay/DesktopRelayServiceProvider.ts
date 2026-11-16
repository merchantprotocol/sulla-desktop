// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DesktopRelayStartupRestorer } from '@pkg/main/cloud/session/DesktopRelayStartupRestorer';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

import type { DesktopRelayClient } from './DesktopRelayClient';

const console = Logging.background;

/** Owns the main-process relay client and binds its IPC, status broadcast and cold-start restore. */
export class DesktopRelayServiceProvider {
  constructor(private readonly client: DesktopRelayClient) {}

  getClient(): DesktopRelayClient {
    return this.client;
  }

  registerEvents(): void {
    const ipcMainProxy = getIpcMainProxy(console);
    const client = this.client;

    ipcMainProxy.handle('desktop-relay:get-status', async() => client.getStatus());

    ipcMainProxy.handle('desktop-relay:set-paired-user-id', async(_event: unknown, userId: string) => {
      await client.setPairedUserId(userId);
      return client.getStatus();
    });

    // Broadcast status changes to renderer
    client.onStatusChange((status) => {
      try {
        const { BrowserWindow } = require('electron') as typeof import('electron');
        for (const win of BrowserWindow.getAllWindows()) {
          try { win.webContents.send('desktop-relay:status-changed', status); } catch { /* ignore */ }
        }
      } catch { /* electron not ready */ }
    });

    // Cold-start restore retries while local settings are booting.
    const startupRestorer = new DesktopRelayStartupRestorer(this.client, {
      failed:    error => console.warn('[DesktopRelay] start() failed (retrying in 10s):', error instanceof Error ? error.message : error),
      exhausted: error => console.error('[DesktopRelay] start() still failing after 5min — giving up until next app start:', error),
    });
    void startupRestorer.restore();
  }
}
