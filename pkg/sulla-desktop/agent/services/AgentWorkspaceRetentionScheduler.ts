// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentWorkspaceRetentionPolicy, WorkspaceRetentionReport } from './AgentWorkspaceRetentionPolicy';

export interface RetentionTimer {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export class NodeRetentionTimer implements RetentionTimer {
  setInterval(callback: () => void, delayMs: number): unknown {
    const handle = setInterval(callback, delayMs);
    (handle as NodeJS.Timeout).unref?.();
    return handle;
  }

  clearInterval(handle: unknown): void {
    clearInterval(handle as NodeJS.Timeout);
  }
}

/**
 * Runs AgentWorkspaceRetentionPolicy once on boot and then on a fixed
 * interval. One enforce() run is always allowed to finish before the next
 * is started; an overrunning run simply delays the following tick.
 */
export class AgentWorkspaceRetentionScheduler {
  private handle: unknown;
  private running = false;

  constructor(
    private readonly policy:     AgentWorkspaceRetentionPolicy,
    private readonly timer:      RetentionTimer,
    private readonly onReport:   (report: WorkspaceRetentionReport) => void = () => {},
    private readonly onError:    (error: unknown) => void = () => {},
    private readonly intervalMs = 60 * 60_000,
  ) {}

  start(): void {
    if (this.handle !== undefined) return;
    void this.runOnce();
    this.handle = this.timer.setInterval(() => { void this.runOnce() }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.timer.clearInterval(this.handle);
    this.handle = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.onReport(await this.policy.enforce());
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
  }
}
