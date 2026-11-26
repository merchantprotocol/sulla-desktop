// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { BrowserWindow, ipcMain, webContents } from 'electron';

import type { AgentStateProjector } from '@pkg/agent/app/Services/AgentStateProjector';
import type { AgentStateService } from '@pkg/agent/app/Services/AgentStateService';
import { AgentModelStatusRegistry } from '@pkg/agent/services/AgentModelStatusRegistry';
import { AGENT_STATE_CHANGED_EVENT, AGENT_STATE_SNAPSHOT_CHANNEL, type AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import { isAgentWindowSender } from '@pkg/window/agentWindowTrust';

/** Coalesces authoritative snapshots and publishes them to every renderer. */
export class AgentStatePublisher {
  private timer?: ReturnType<typeof setTimeout>;
  private snapshotInFlight?:  Promise<AgentStateSnapshot>;
  private publishing = false;
  private dirty = false;
  private disposed = false;
  private unsubscribe?: () => void;
  private unsubscribeModels?: () => void;
  constructor(private readonly states: AgentStateService, private readonly projector: AgentStateProjector, private readonly delayMs = 250) {}
  register(): void {
    this.disposed = false;
    ipcMain.handle('agents:result-tracking', async(_event, ownerThread: string) => {
      if (typeof ownerThread !== 'string' || !ownerThread.trim() || ownerThread.length > 512) throw new Error('A manager conversation is required.');
      return await this.states.resultTrackingForParentThread(ownerThread);
    });
    ipcMain.handle(AGENT_STATE_SNAPSHOT_CHANNEL, () => this.snapshot());
    this.unsubscribe = this.states.onChange(() => this.schedule());
    this.unsubscribeModels = AgentModelStatusRegistry.onChange(() => this.states.touch());
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
      const windows = new Set(BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => window.webContents));
      // Hosted chat tabs are WebContentsViews and do not appear in the BrowserWindow list.
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        const url = contents.getURL();
        const appWindow = windows.has(contents) && /^(file:|app:)/.test(url);
        const chatView = url.startsWith('app://./agent.html?') && isAgentWindowSender(contents);
        if (!appWindow && !chatView) continue;
        try {
          contents.send(AGENT_STATE_CHANGED_EVENT, snapshot);
        } catch (error) {
          console.debug('[AgentStatePublisher] Could not update a desktop view:', error);
        }
      }
    } finally {
      this.publishing = false;
      if (this.dirty && !this.disposed) this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribeModels?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    ipcMain.removeHandler(AGENT_STATE_SNAPSHOT_CHANNEL);
    ipcMain.removeHandler('agents:result-tracking');
  }
}
