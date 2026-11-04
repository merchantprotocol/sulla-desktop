// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ContainerRuntimeDriver } from '@pkg/runtime/containerRuntime';
import { ContainerRetentionPolicy, RetentionConfig } from './AgentContainerRetentionPolicy';
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
    config = new RetentionConfig(),
  ) {
    const policy = new ContainerRetentionPolicy(
      runtime,
      new GuestDiskSpaceProbe(new SullaRuntimeCommandRunner(runtimeBinary)),
      { now: () => Date.now() },
      { isActive: () => false },
      config,
    );
    this.scheduler = new ContainerRetentionScheduler(policy, timer, logger, config.intervalMs);
  }

  start(): void { this.scheduler.start() }
  dispose(): void { this.scheduler.stop() }
}
