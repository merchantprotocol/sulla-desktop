// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentWorkspaceRetentionBootstrap } from '../../../../services/AgentWorkspaceRetentionBootstrap';
import { WorkspaceRetentionConfig } from '../../../../services/AgentWorkspaceRetentionConfig';
import type { GitCommandResult, WorkspaceDirEntryStat } from '../../../../services/AgentWorkspaceInspector';

class FakeTimer {
  callbacks: Array<() => void> = []; cleared = 0;
  setInterval(callback: () => void): unknown { this.callbacks.push(callback); return 1; }
  clearInterval(): void { this.cleared++; }
}
class FakeGuestDriver {
  lists = 0;
  async readdir(): Promise<string[]> { this.lists++; return []; }
  async lstat(): Promise<WorkspaceDirEntryStat> { throw new Error('unused'); }
  async rename(): Promise<void> { throw new Error('unused'); }
  async run(): Promise<GitCommandResult> { return { stdout: '', exitCode: 0 }; }
  async remove(): Promise<number> { throw new Error('unused'); }
  async preserve(): Promise<string> { throw new Error('unused'); }
}

describe('AgentWorkspaceRetentionBootstrap', () => {
  it('runs an immediate guest sweep, starts one timer, and stops it on dispose', async() => {
    // risk: dead retention code never reclaims boot backlog or survives shutdown
    const timer = new FakeTimer();
    const driver = new FakeGuestDriver();
    const bootstrap = new AgentWorkspaceRetentionBootstrap(
      { state: async() => undefined }, { freeBytes: async() => Number.MAX_SAFE_INTEGER }, timer,
      { info: () => {}, error: () => {} }, new WorkspaceRetentionConfig({ intervalMs: 123 }), driver,
    );
    bootstrap.start(); bootstrap.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(driver.lists).toBe(1);
    expect(timer.callbacks).toHaveLength(1);
    bootstrap.dispose();
    expect(timer.cleared).toBe(1);
  });
});
