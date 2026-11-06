// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';

import { Notification, app } from 'electron';

import { getWorkflowManagerClient } from '@pkg/agent/services/WorkflowManagerClient';
import * as settingsImpl from '@pkg/config/settingsImpl';
import { StorageWatchService, type StorageLevel } from '@pkg/main/StorageWatchService';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

class MacDataVolumeProbe {
  async read() {
    const stats = await fs.statfs(app.getPath('userData'));
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize, vmUsedPct: 'unknown' as const };
  }
}

class DesktopStorageWatchSettingsStore {
  read() { return settingsImpl.getSettings().storageWatch }
  writeLastRun(level: StorageLevel, timestamp: number): void {
    const config = settingsImpl.getSettings();
    if (level === 'critical') config.storageWatch.lastCriticalAt = timestamp;
    else config.storageWatch.lastWarningAt = timestamp;
    settingsImpl.save(config);
  }
}

class StorageOptimizerWorkflowRunner {
  async isRunInProgress(): Promise<boolean> {
    const { getWorkflowRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
    const definition = await getWorkflowRegistry().loadWorkflow('storage-optimizer-run');
    if (!definition) return false;
    const { WorkflowExecutionModel } = await import('@pkg/agent/database/models/WorkflowExecutionModel');
    return (await WorkflowExecutionModel.countActiveByWorkflow(definition.id)) > 0;
  }

  async start(inputs: Record<string, string | number>): Promise<'started' | 'unavailable'> {
    const { getWorkflowRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
    if (!await getWorkflowRegistry().loadWorkflow('storage-optimizer-run')) return 'unavailable';
    await getWorkflowManagerClient().startRun({
      workflowId: 'storage-optimizer-run', inputs, message: JSON.stringify(inputs),
    });
    return 'started';
  }
}

class NativeStorageNotifier {
  show(message: string): void {
    if (Notification.isSupported()) new Notification({ title: 'Sulla Storage Optimizer', body: message }).show();
  }
}

/** Main-process composition root for the platform-specific storage watcher. */
export class DesktopStorageWatchService {
  private readonly service: StorageWatchService;

  constructor(private readonly platform = process.platform) {
    const probe = new MacDataVolumeProbe();
    this.service = new StorageWatchService(
      () => probe.read(), new DesktopStorageWatchSettingsStore(), new StorageOptimizerWorkflowRunner(),
      new NativeStorageNotifier(), { now: () => Date.now() }, console,
    );
  }

  start(): void { if (this.platform === 'darwin') this.service.start() }
  stop(): void { this.service.stop() }
}
