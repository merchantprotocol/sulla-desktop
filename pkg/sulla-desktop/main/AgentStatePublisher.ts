// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { BrowserWindow, ipcMain } from 'electron';
import { AGENT_STATE_CHANGED_EVENT, AGENT_STATE_SNAPSHOT_CHANNEL } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { AgentStateProjector } from '@pkg/agent/app/Services/AgentStateProjector';
import type { AgentStateService } from '@pkg/agent/app/Services/AgentStateService';

/** Coalesces authoritative snapshots and publishes them to every renderer. */
export class AgentStatePublisher {
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  constructor(private readonly states: AgentStateService, private readonly projector: AgentStateProjector, private readonly delayMs = 250) {}
  register(): void {
    ipcMain.handle(AGENT_STATE_SNAPSHOT_CHANNEL, () => this.projector.snapshot());
    this.unsubscribe = this.states.onChange(() => this.schedule());
  }
  private schedule(): void { if (this.timer) return; this.timer = setTimeout(() => void this.publish(), this.delayMs); }
  private async publish(): Promise<void> {
    this.timer = undefined;
    const snapshot = await this.projector.snapshot();
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_STATE_CHANGED_EVENT, snapshot);
  }
  dispose(): void { this.unsubscribe?.(); if (this.timer) clearTimeout(this.timer); ipcMain.removeHandler(AGENT_STATE_SNAPSHOT_CHANNEL); }
}
