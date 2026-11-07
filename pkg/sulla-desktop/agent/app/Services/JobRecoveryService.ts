// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import type { JobWrapUpService } from './JobWrapUpService';
export class JobRecoveryService extends Service {
  private hydration: Promise<void> | null = null;
  constructor(private readonly repository: AgentJobRepository,private readonly wrapUp?:Pick<JobWrapUpService,'recover'>) { super(); }
  ensureHydrated(): Promise<void> {
    this.hydration ??= Promise.all([this.repository.sweepInterruptedJobs(),this.wrapUp?.recover()]).then(()=>undefined).catch((error) => console.warn('[AgentJobService] boot sweep failed (will rely on durable state for the next replay):', (error as Error).message));
    return this.hydration;
  }
  reset(): void { this.hydration = null; }
}
