// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { reloadExtensionHooks } from '@pkg/agent/extensions/ExtensionLoader';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { WindowBootTelemetry } from '@pkg/agent/startup/WindowBootTelemetry';
import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

interface WindowContextIpc {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
}

/** Renderer-side settings and extension hydration for a window. */
export class WindowContextInitializer {
  private boot?: WindowBootTelemetry;
  private hydration?: Promise<void>;

  constructor(private readonly ipc: () => WindowContextIpc = () => require('electron').ipcRenderer) {}

  // The main process constructs this class too. Only the renderer reads its URL
  // when it starts hydration.
  private get telemetry(): WindowBootTelemetry {
    if (!this.boot) {
      const query = new URLSearchParams(globalThis.window?.location.search ?? '');
      const windowKey = query.get('windowKey') || 'main';
      const startupId = query.get('startupId') || crypto.randomUUID();
      this.boot = new WindowBootTelemetry(startupId, windowKey, (event, status, elapsedMs) =>
        this.ipc().invoke('sulla-startup:stage', { startupId, windowKey, event, status, elapsedMs }));
    }
    return this.boot;
  }

  /** Start window hydration without making it a prerequisite for first paint. */
  startForFirstPaint(): void {
    void this.hydrateOnce();
  }

  /** Bound the wait for callers that mount after initialization. Hydration continues in the background. */
  async initialize(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.hydrateOnce(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 8_000) }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private hydrateOnce(): Promise<void> {
    this.hydration ??= this.hydrate().catch((error: unknown) => {
      console.error('[WindowContext] Window context hydration failed:', error);
    });
    return this.hydration;
  }

  private async hydrate(): Promise<void> {
    const telemetry = this.telemetry;
    const { startupId, windowKey } = telemetry;
    const ipc = this.ipc();
    telemetry.emit('window-context-hydration', 'start');
    let stage = 'renderer-settings-bootstrap';
    let settingsFailed = false;
    telemetry.emit(stage, 'start');
    try {
      const userDataPath = await ipc.invoke('get-user-data-path');
      telemetry.emit('user-data-path', 'end');
      const fallbackPath = require('path').join(userDataPath, 'sulla-settings-fallback.json');
      SullaSettingsModel.setFallbackFilePath(fallbackPath);
      await SullaSettingsModel.readBootstrapFile();
      telemetry.emit('settings-ready-from-fallback');
      telemetry.emit(stage, 'end');

      stage = 'wait-for-backends';
      telemetry.emit(stage, 'start');
      await ipc.invoke('sulla-settings:wait-for-backends', { startupId, windowKey });
      telemetry.emit(stage, 'end');

      stage = 'settings-bootstrap';
      telemetry.emit(stage, 'start');
      await SullaSettingsModel.bootstrap();
      telemetry.emit(stage, 'end');
      telemetry.emit('settings-ready');
    } catch (error) {
      settingsFailed = true;
      telemetry.emit(stage, 'failure');
      console.error('[WindowContext] Failed to initialize settings:', error);
    }

    stage = 'extension-initialization';
    telemetry.emit(stage, 'start');
    try {
      const extensions = getExtensionService();
      extensions.setStartupTelemetry(telemetry);
      await extensions.initialize();
      await reloadExtensionHooks();
      telemetry.emit(stage, 'end');
      telemetry.emit('extensions-ready');
    } catch (error) {
      telemetry.emit(stage, 'failure');
      telemetry.emit('window-context-hydration', 'failure');
      console.error('[ExtensionService] Failed to initialize:', error);
      return;
    }
    telemetry.emit('window-context-hydration', settingsFailed ? 'failure' : 'end');
  }
}
