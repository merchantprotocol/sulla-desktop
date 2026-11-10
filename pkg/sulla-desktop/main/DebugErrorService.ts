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
  constructor(private readonly dependencies: DebugErrorServiceDependencies) {}

  async reportError(source: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? '' : '';
    this.dependencies.warn(source, error);
    if (!await this.dependencies.enabled()) return;

    const record: DebugError = {
      timestamp: this.dependencies.now().toISOString(),
      process: this.dependencies.processName,
      source,
      message,
      stack,
    };
    this.dependencies.relay(record);
    const file = path.join(this.dependencies.logsDir(), 'debug-errors.log');
    await this.dependencies.append(file, `${ JSON.stringify(record) }\n`);
  }
}

export const debugErrorService = new DebugErrorService({
  enabled: async() => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    return (await SullaSettingsModel.get('application.debug', false)) === true;
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
