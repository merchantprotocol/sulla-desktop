// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { reloadExtensionHooks } from '@pkg/agent/extensions/ExtensionLoader';
import { WindowBootTelemetry } from '@pkg/agent/startup/WindowBootTelemetry';
import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/** Renderer-side settings and extension hydration for a window. */
export class WindowContextInitializer {
  private readonly query = new URLSearchParams(window.location.search);
  private readonly windowKey = this.query.get('windowKey') || 'main';
  private readonly telemetry = new WindowBootTelemetry(this.query.get('startupId') || crypto.randomUUID(), this.windowKey, (event, status, elapsedMs) => {
    const { ipcRenderer } = require('electron');
    return ipcRenderer.invoke('sulla-startup:stage', { startupId: this.telemetry.startupId, windowKey: this.telemetry.windowKey, event, status, elapsedMs });
  });

  /** Start window hydration without making it a prerequisite for first paint. */
  startForFirstPaint(): void {
    this.telemetry.emit('window-context-hydration', 'start');
    void this.initialize().then(() => {
      this.telemetry.emit('window-context-hydration', 'end');
    }).catch((error: unknown) => {
      this.telemetry.emit('window-context-hydration', 'failure');
      console.error('[WindowBoot] window context hydration failed:', error);
    });
  }

  async initialize(): Promise<void> {
    this.telemetry.emit('renderer-settings-bootstrap', 'start');
    // This function serves as the explicit initialization hook
    console.log('[WindowContext] Sulla window context initialized');

    const windowKey = this.windowKey;

    // Get the user data path from main process
    const { ipcRenderer } = require('electron');
    try {
      const userDataPath = await ipcRenderer.invoke('get-user-data-path');
      this.telemetry.emit('user-data-path', 'end');
      const fallbackPath = require('path').join(userDataPath, 'sulla-settings-fallback.json');
      SullaSettingsModel.setFallbackFilePath(fallbackPath);
      console.log('[WindowContext] Fallback path set to:', fallbackPath);

      // Every window waits on the same backend lifecycle gate. Bootstrapping
      // secondary windows immediately races cold Redis/Postgres and exhausts
      // the settings model's short retry budget before the backends start.
      // Keep all settings/extension work off the first-paint path; warm windows
      // bootstrap as soon as the main process reports database readiness.
      let activeStage = 'wait-for-backends';
      this.telemetry.emit('wait-for-backends', 'start');
      const backendsReady = ipcRenderer.invoke('sulla-settings:wait-for-backends', { startupId: this.telemetry.startupId, windowKey: this.telemetry.windowKey });
      void backendsReady.then(async() => {
        this.telemetry.emit('wait-for-backends', 'end');
        activeStage = 'settings-bootstrap';
        this.telemetry.emit('settings-bootstrap', 'start');
        await SullaSettingsModel.bootstrap();
        this.telemetry.emit('settings-bootstrap', 'end');
        this.telemetry.emit('settings-ready');

        const extensionService = getExtensionService();
        extensionService.setStartupTelemetry(this.telemetry);
        activeStage = 'extension-initialization';
        this.telemetry.emit('extension-initialization', 'start');
        await extensionService.initialize();
        await reloadExtensionHooks();
        this.telemetry.emit('extension-initialization', 'end');
        this.telemetry.emit('extensions-ready');
      }).catch((error: unknown) => {
        this.telemetry.emit(activeStage, 'failure');
        this.telemetry.emit('window-context-hydration', 'failure');
        console.error(`[WindowContext] Backend-dependent hydration failed for ${ windowKey }:`, error);
      });
    } catch (error) {
      this.telemetry.emit('renderer-settings-bootstrap', 'failure');
      console.error('[WindowContext] Failed to initialize settings:', error);
    }
  }
}
