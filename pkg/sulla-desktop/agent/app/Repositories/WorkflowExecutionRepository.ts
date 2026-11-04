// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Persistence boundary for recovery. The dynamic model import preserves the agent's lazy database startup. */
export class WorkflowExecutionRepository {
  private async model() { return (await import('../../database/models/WorkflowExecutionModel')).WorkflowExecutionModel; }
  async findStaleExecutions() { return (await this.model()).findStaleExecutions(); }
  async findSuspended() { return (await this.model()).findSuspended(); }
  async recover(executionId: string) { return (await this.model()).recover(executionId); }
  async suspendAllRunning(): Promise<string[]> { return (await this.model()).suspendAllRunning(); }
  async nextLeaseExpiry(): Promise<Date | null> { return (await this.model()).nextLeaseExpiry(); }
}
