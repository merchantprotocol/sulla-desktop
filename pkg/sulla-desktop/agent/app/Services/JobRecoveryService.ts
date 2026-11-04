// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
export class JobRecoveryService extends Service {
  private hydration: Promise<void> | null = null;
  constructor(private readonly repository: AgentJobRepository) { super(); }
  ensureHydrated(): Promise<void> {
    this.hydration ??= this.repository.sweepInterruptedJobs().catch((error) => console.warn('[AgentJobService] boot sweep failed (will rely on in-memory state):', (error as Error).message));
    return this.hydration;
  }
  reset(): void { this.hydration = null; }
}
