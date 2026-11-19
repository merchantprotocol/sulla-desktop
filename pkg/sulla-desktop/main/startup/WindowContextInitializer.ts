// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { reloadExtensionHooks } from '@pkg/agent/extensions/ExtensionLoader';
import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

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

  async initialize(): Promise<void> {
    const startedAt = Date.now();
    // This function serves as the explicit initialization hook
    console.log('[WindowContext] Sulla window context initialized');

    const windowKey = new URLSearchParams(window.location.search).get('windowKey') || 'main';

    // Get the user data path from main process
    const { ipcRenderer } = require('electron');
    try {
      const userDataPath = await ipcRenderer.invoke('get-user-data-path');
      console.info(`[WindowBoot] user-data IPC handshake received after ${ Date.now() - startedAt }ms`);
      const fallbackPath = require('path').join(userDataPath, 'sulla-settings-fallback.json');
      SullaSettingsModel.setFallbackFilePath(fallbackPath);
      console.log('[WindowContext] Fallback path set to:', fallbackPath);

      // Every window waits on the same backend lifecycle gate. Bootstrapping
      // secondary windows immediately races cold Redis/Postgres and exhausts
      // the settings model's short retry budget before the backends start.
      // Keep all settings/extension work off the first-paint path; warm windows
      // bootstrap as soon as the main process reports database readiness.
      const backendsReady = ipcRenderer.invoke('sulla-settings:wait-for-backends');
      void backendsReady.then(async() => {
        console.info(`[WindowBoot] settings backend handshake received after ${ Date.now() - startedAt }ms`);
        const settingsStartedAt = Date.now();
        await SullaSettingsModel.bootstrap();
        console.info(`[WindowBoot] settings bootstrap finished after ${ Date.now() - settingsStartedAt }ms`);

        const extensionsStartedAt = Date.now();
        const extensionService = getExtensionService();
        await extensionService.initialize();
        await reloadExtensionHooks();
        console.info(`[WindowBoot] extension hydration finished after ${ Date.now() - extensionsStartedAt }ms`);
      }).catch((error: unknown) => console.error(`[WindowContext] Backend-dependent hydration failed for ${ windowKey }:`, error));
    } catch (error) {
      console.error('[WindowContext] Failed to initialize settings:', error);
    }
  }
}
