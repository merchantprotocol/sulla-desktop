// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import type { JobWrapUpService } from './JobWrapUpService';
import type { LaunchingTaskExecutionReconciler } from './LaunchingTaskExecutionReconciler';
export class JobRecoveryService extends Service {
  private hydration: Promise<void> | null = null;
  constructor(
    private readonly repository:AgentJobRepository,
    private readonly wrapUp?:Pick<JobWrapUpService,'recover'>,
    private readonly launches?:Pick<LaunchingTaskExecutionReconciler,'reconcile'>,
  ){super();}
  ensureHydrated(): Promise<void> {
    this.hydration ??= this.recoverDurableState().catch((error) => console.warn('[AgentJobService] boot sweep failed (will rely on durable state for the next replay):', (error as Error).message));
    return this.hydration;
  }
  private async recoverDurableState():Promise<void>{
    await this.launches?.reconcile();
    await Promise.all([this.repository.sweepInterruptedJobs(),this.wrapUp?.recover()]);
  }
  reset(): void { this.hydration = null; }
}
