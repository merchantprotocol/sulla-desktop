// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentsListResponse } from '@pkg/main/agentsIpc';
import type { VisibilitySource } from './AgentDetailFeed';
import { RefreshSequencer } from './RefreshSequencer';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type TimerHandle = ReturnType<typeof setInterval>;

export class AgentsListPoller {
  private timer: TimerHandle | undefined;
  private readonly refreshSequencer = new RefreshSequencer();

  constructor(
    private readonly invoke: (channel: string) => Promise<unknown>,
    private readonly visibility: VisibilitySource,
    private readonly setTimer: (callback: () => void, milliseconds: number) => TimerHandle,
    private readonly clearTimer: (handle: TimerHandle) => void,
    private readonly onData: (data: AgentsListResponse) => void,
    private readonly onAvailability: (available: boolean) => void,
    private readonly intervalMs = 15_000,
    private readonly onError: (reason: string) => void = () => undefined,
    private readonly reportError: (source: string, error: unknown) => void = (source, error) => ipcRenderer.send('debug:report' as any, source, { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' }),
  ) {}

  start(): void {
    if (this.timer) return;
    this.visibility.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.timer = this.setTimer(() => {
      if (!this.visibility.hidden) void this.refresh();
    }, this.intervalMs);
    if (!this.visibility.hidden) void this.refresh();
  }

  stop(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    this.visibility.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  dispose(): void {
    this.stop();
  }

  async refresh(): Promise<void> {
    if (this.visibility.hidden) return;
    const ticket = this.refreshSequencer.next();

    try {
      const data = await this.invoke('agents:list') as AgentsListResponse;

      if (!this.refreshSequencer.tryApply(ticket)) return;
      this.onData(data);
      this.onAvailability(true);
    } catch (error) {
      this.reportError('live-agents:list', error);
      if (!this.refreshSequencer.hasAppliedNewerThan(ticket)) {
        const reason = error instanceof Error ? error.message : String(error);
        this.onAvailability(false);
        this.onError(reason);
      }
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.visibility.hidden) void this.refresh();
  };
}
