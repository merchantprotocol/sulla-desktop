// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ContainerRuntimeDriver } from '@pkg/runtime/containerRuntime';
import type { Clock } from '@sulla/foundation';
import { AgentJobMessagingModel } from '../database/models/AgentJobMessagingModel';
import { AgentContainerLaunchCoordinator, type AgentLaunchJobReporter } from './AgentContainerLaunchCoordinator';
import { IdempotentRetry } from './AgentContainerStartupRetry';
import { SullaFilesBindPlanner, SullaFilesMountHealthProbe, SullaRuntimeGuestCommandRunner, type MountAvailabilityView } from './SullaFilesMountHealthProbe';

class DateClock implements Clock {
  now(): Date { return new Date() }
}

export class AgentJobCheckinReporter implements AgentLaunchJobReporter {
  constructor(private readonly threadId?: string) {}

  warning(message: string): Promise<void> { return this.append('container-warning', message) }
  failure(message: string): Promise<void> { return this.append('container-failure', message) }

  private async append(step: string, summary: string): Promise<void> {
    if (!this.threadId) return;
    await AgentJobMessagingModel.appendCheckin(this.threadId, { step, summary, blockers: step === 'container-failure' ? [summary] : [] });
  }
}

/** Per-launch composition: all mutable state stays in the injected instances. */
export class AgentContainerLaunchComposition {
  constructor(
    private readonly runtime: ContainerRuntimeDriver,
    private readonly mountManager: MountAvailabilityView,
    private readonly runtimeBinary: string,
    private readonly clock: Clock = new DateClock(),
  ) {}

  create(threadId?: string): AgentContainerLaunchCoordinator {
    const probe = new SullaFilesMountHealthProbe(
      this.mountManager,
      new SullaRuntimeGuestCommandRunner(this.runtimeBinary),
      this.clock,
    );
    return new AgentContainerLaunchCoordinator(
      this.runtime,
      new IdempotentRetry(),
      new SullaFilesBindPlanner(probe),
      new AgentJobCheckinReporter(threadId),
    );
  }
}
