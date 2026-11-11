// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import { app, BrowserWindow } from 'electron';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';

export interface DebugError {
  timestamp: string;
  process: string;
  source: string;
  message: string;
  stack: string;
}

export interface DebugErrorServiceDependencies {
  enabled: () => Promise<boolean>;
  append: (file: string, content: string) => Promise<void>;
  logsDir: () => string;
  relay: (error: DebugError) => void;
  warn: (source: string, error: unknown) => void;
  now: () => Date;
  processName: string;
}

export class DebugErrorService {
  private readonly recentErrors: DebugError[] = [];

  constructor(private readonly dependencies: DebugErrorServiceDependencies) {}

  recent(): DebugError[] { return [...this.recentErrors] }

  async reportError(source: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? '' : '';
    this.dependencies.warn(source, error);
    let debugEnabled = false;
    try {
      debugEnabled = await this.dependencies.enabled();
    } catch (settingsError) {
      this.dependencies.warn('debug:error-settings', settingsError);
    }
    if (!debugEnabled) return;

    const record: DebugError = {
      timestamp: this.dependencies.now().toISOString(),
      process: this.dependencies.processName,
      source,
      message,
      stack,
    };
    this.recentErrors.unshift(record);
    if (this.recentErrors.length > 100) this.recentErrors.length = 100;
    const file = path.join(this.dependencies.logsDir(), 'debug-errors.log');
    try {
      this.dependencies.relay(record);
    } catch (relayError) {
      this.dependencies.warn('debug:error-relay', relayError);
    }
    try {
      await this.dependencies.append(file, `${ JSON.stringify(record) }\n`);
    } catch (writeError) {
      this.dependencies.warn('debug:error-log-write', writeError);
    }
  }
}

export const debugErrorService = new DebugErrorService({
  enabled: async() => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    const enabled = await SullaSettingsModel.get('application.debug', false);
    return enabled === true || enabled === 'true';
  },
  append: async(file, content) => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, content, 'utf8');
  },
  logsDir: () => app.getPath('logs'),
  relay: error => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('debug:error', error);
    }
  },
  warn: (source, error) => console.warn(`[${ source }]`, error),
  now: () => new Date(),
  processName: process.type ?? 'main',
});

export function initDebugErrorReporting(): void {
  process.on('uncaughtExceptionMonitor', error => { void debugErrorService.reportError('main:uncaughtException', error) });
  process.on('unhandledRejection', reason => { void debugErrorService.reportError('main:unhandledRejection', reason) });
  const { ipcMain } = require('electron') as typeof import('electron');
  ipcMain.on('debug:report', (_event, source: string, error: { message?: string; stack?: string }) => {
    const reported = new Error(error?.message || 'Renderer error');
    reported.stack = error?.stack || reported.stack;
    void debugErrorService.reportError(`renderer:${ source }`, reported);
  });
  ipcMain.handle('debug:errors:list', () => debugErrorService.recent());
}
