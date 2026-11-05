// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { WorkspaceInspector } from './AgentWorkspaceInspector';
import { WorkspaceRetentionConfig } from './AgentWorkspaceRetentionConfig';
import { AgentWorkspaceRetentionPolicy, type DiskSpaceProbe, type WorkspaceJobStateReader } from './AgentWorkspaceRetentionPolicy';
import { AgentWorkspaceRetentionScheduler, type RetentionTimer } from './AgentWorkspaceRetentionScheduler';
import { GUEST_AGENT_WORKSPACES_ROOT } from './GuestRuntimeTransport';
import { GuestWorkspaceRuntimeDriver, type WorkspaceRuntimeDriver } from './GuestWorkspaceRuntimeDriver';

export interface WorkspaceRetentionLogger { info(message: string): void; error(message: string): void; }

/** App-owned lifecycle hook for guest workspace retention. */
export class AgentWorkspaceRetentionBootstrap {
  private readonly scheduler: AgentWorkspaceRetentionScheduler;
  constructor(
    jobs: WorkspaceJobStateReader,
    disk: DiskSpaceProbe,
    timer: RetentionTimer,
    logger: WorkspaceRetentionLogger,
    config = new WorkspaceRetentionConfig(),
    driver: WorkspaceRuntimeDriver = new GuestWorkspaceRuntimeDriver(),
  ) {
    const policy = new AgentWorkspaceRetentionPolicy(
      GUEST_AGENT_WORKSPACES_ROOT, driver, new WorkspaceInspector(driver, driver), { isActive: () => false },
      { now: () => Date.now() }, disk, driver, config, undefined, jobs, driver,
    );
    this.scheduler = new AgentWorkspaceRetentionScheduler(
      policy, timer,
      report => {
        for (const removed of report.removed) logger.info(`[WorkspaceRetention] job=${removed.jobId} path=${removed.path} bytes=${removed.bytesFreed ?? 'unknown'} rule=${removed.reason}`);
        logger.info(`[WorkspaceRetention] removed=${report.removed.length} bytes=${report.bytesFreed} unsafe=${report.keptUnsafe.length} errors=${report.errors.length}`);
      },
      error => logger.error(`[WorkspaceRetention] sweep failed: ${error instanceof Error ? error.message : String(error)}`),
      config.intervalMs,
    );
  }
  start(): void { this.scheduler.start(); }
  dispose(): void { this.scheduler.stop(); }
}
