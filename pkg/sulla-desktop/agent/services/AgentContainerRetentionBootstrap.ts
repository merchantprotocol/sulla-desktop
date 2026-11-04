// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ContainerRuntimeDriver } from '@pkg/runtime/containerRuntime';
import { ContainerRetentionPolicy, RetentionConfig, type ActiveContainerGuard, type DiskSpaceProbe } from './AgentContainerRetentionPolicy';
import { ContainerRetentionScheduler, type RetentionSchedulerLogger, type RetentionSchedulerTimer } from './AgentContainerRetentionScheduler';
import { GuestDiskSpaceProbe, SullaRuntimeCommandRunner } from './GuestDiskSpaceProbe';

/** App-owned boot hook. start() is idempotent; dispose() releases its timer. */
export class AgentContainerRetentionBootstrap {
  private readonly scheduler: ContainerRetentionScheduler;

  constructor(
    runtime: ContainerRuntimeDriver,
    runtimeBinary: string,
    timer: RetentionSchedulerTimer,
    logger: RetentionSchedulerLogger,
    activeContainers: ActiveContainerGuard,
    config = new RetentionConfig(),
    disk: DiskSpaceProbe = new GuestDiskSpaceProbe(new SullaRuntimeCommandRunner(runtimeBinary)),
  ) {
    const policy = new ContainerRetentionPolicy(
      runtime,
      disk,
      { now: () => Date.now() },
      activeContainers,
      config,
    );
    this.scheduler = new ContainerRetentionScheduler(policy, timer, logger, config.intervalMs);
  }

  start(): void { this.scheduler.start() }
  dispose(): void { this.scheduler.stop() }
}
