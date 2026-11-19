// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { reloadExtensionHooks } from '@pkg/agent/extensions/ExtensionLoader';
import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

interface WindowContextIpc {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
}

/** Renderer-side settings and extension hydration for a window. */
export class WindowContextInitializer {
  /** Start window hydration without making it a prerequisite for first paint. */
  startForFirstPaint(): void {
    const startedAt = Date.now();
    console.info(`[WindowBoot] window context hydration started at ${ startedAt }`);
    void this.initialize().then(() => {
      console.info(`[WindowBoot] window context hydration finished after ${ Date.now() - startedAt }ms`);
    }).catch((error: unknown) => console.error('[WindowBoot] window context hydration failed:', error));
  }

  constructor(private readonly ipc: () => WindowContextIpc = () => require('electron').ipcRenderer) {}

  async initialize(): Promise<void> {
    const startup = this.hydrate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        startup,
        new Promise<void>(resolve => { timer = setTimeout(resolve, 8_000) }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async hydrate(): Promise<void> {
    const startedAt = Date.now();
    const windowKey = new URLSearchParams(globalThis.window?.location.search ?? '').get('windowKey') || 'main';
    try {
      // Get the user data path from main process
      const ipcRenderer = this.ipc();
      const userDataPath = await ipcRenderer.invoke('get-user-data-path');
      console.info(`[WindowBoot] user-data IPC handshake received after ${ Date.now() - startedAt }ms`);
      const fallbackPath = require('path').join(userDataPath, 'sulla-settings-fallback.json');
      SullaSettingsModel.setFallbackFilePath(fallbackPath);
      console.log('[WindowContext] Fallback path set to:', fallbackPath);

      // Renderer settings share the main-process backends. Wait for the lifecycle
      // readiness signal instead of racing cold Redis with a short retry budget.
      // Every window awaits this before mounting, so only hold the mount for a
      // short bound; on a cold boot finish bootstrapping in the background so
      // the loading overlay can render while Redis/Postgres come up.
      if (windowKey === 'main') {
        await ipcRenderer.invoke('sulla-settings:wait-for-backends');
        console.info(`[WindowBoot] settings backend handshake received after ${ Date.now() - startedAt }ms`);
      }
      await SullaSettingsModel.bootstrap();
    } catch (error) {
      console.error('[WindowContext] Failed to initialize settings:', error);
    }

    // Initialize extension service
    try {
      const extensionService = getExtensionService();
      await extensionService.initialize();
      await reloadExtensionHooks();
    } catch (error) {
      console.error('[ExtensionService] Failed to initialize:', error);
    }
  }
}
