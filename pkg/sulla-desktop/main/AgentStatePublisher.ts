// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { BrowserWindow, ipcMain } from 'electron';

import type { AgentStateProjector } from '@pkg/agent/app/Services/AgentStateProjector';
import type { AgentStateService } from '@pkg/agent/app/Services/AgentStateService';
import { AgentModelStatusRegistry } from '@pkg/agent/services/AgentModelStatusRegistry';
import { RunActivity } from '@pkg/agent/services/RunActivity';
import { AGENT_STATE_CHANGED_EVENT, AGENT_STATE_SNAPSHOT_CHANNEL, type AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';

export interface AgentStateActivitySource {
  onChange(listener: (keys: readonly string[]) => void): () => void;
}

/** Coalesces authoritative snapshots and publishes them to every renderer. */
export class AgentStatePublisher {
  private timer?: ReturnType<typeof setTimeout>;
  private activityTimer?: ReturnType<typeof setTimeout>;
  private activityDirty = false;
  private lastActivityTouchAt = 0;
  private snapshotInFlight?:  Promise<AgentStateSnapshot>;
  private publishing = false;
  private dirty = false;
  private disposed = false;
  private unsubscribe?: () => void;
  private unsubscribeModels?: () => void;
  private unsubscribeActivity?: () => void;
  constructor(private readonly states: AgentStateService, private readonly projector: AgentStateProjector, private readonly delayMs = 250,
    private readonly activity: AgentStateActivitySource = RunActivity, private readonly activityIntervalMs = 1_000) {}
  register(): void {
    this.disposed = false;
    ipcMain.handle('agents:result-tracking', async(_event, ownerThread: string) => {
      if (typeof ownerThread !== 'string' || !ownerThread.trim() || ownerThread.length > 512) throw new Error('A manager conversation is required.');
      return await this.states.resultTrackingForParentThread(ownerThread);
    });
    ipcMain.handle(AGENT_STATE_SNAPSHOT_CHANNEL, () => this.snapshot());
    this.unsubscribe = this.states.onChange(() => this.schedule());
    this.unsubscribeModels = AgentModelStatusRegistry.onChange(() => this.states.touch());
    this.unsubscribeActivity = this.activity.onChange(() => this.scheduleActivityTouch());
  }

  /** Advance snapshot versions at most once a second while activity streams, without losing cumulative counts. */
  private scheduleActivityTouch(): void {
    this.activityDirty = true;
    if (this.disposed || this.activityTimer) return;
    const delay = Math.max(0, this.lastActivityTouchAt + this.activityIntervalMs - Date.now());
    this.activityTimer = setTimeout(() => {
      this.activityTimer = undefined;
      if (this.disposed || !this.activityDirty) return;
      this.activityDirty = false;
      this.lastActivityTouchAt = Date.now();
      this.states.touch();
    }, delay);
  }

  private schedule(): void {
    this.dirty = true;
    if (this.disposed || this.timer || this.publishing) return;
    this.timer = setTimeout(() => void this.publish().catch(error => console.error('[AgentStatePublisher] snapshot publish failed:', error)), this.delayMs);
  }

  private snapshot(): Promise<AgentStateSnapshot> {
    if (this.snapshotInFlight) return this.snapshotInFlight;
    const read = this.projector.snapshot().finally(() => {
      if (this.snapshotInFlight === read) this.snapshotInFlight = undefined;
    });
    this.snapshotInFlight = read;
    return read;
  }

  private async publish(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) return;
    this.publishing = true;
    this.dirty = false;
    try {
      const snapshot = await this.snapshot();
      if (this.disposed) return;
      // An IPC reader may have started before the change that scheduled this publish.
      if (snapshot.version < this.states.version) this.dirty = true;
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_STATE_CHANGED_EVENT, snapshot);
    } finally {
      this.publishing = false;
      if (this.dirty && !this.disposed) this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribeModels?.();
    this.unsubscribeActivity?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.timer = undefined;
    this.activityTimer = undefined;
    this.activityDirty = false;
    ipcMain.removeHandler(AGENT_STATE_SNAPSHOT_CHANNEL);
    ipcMain.removeHandler('agents:result-tracking');
  }
}
