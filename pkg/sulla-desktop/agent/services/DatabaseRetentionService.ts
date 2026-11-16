// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SubjectMemorySentModel } from '../database/models/SubjectMemorySentModel';
import { WorkflowCheckpointModel } from '../database/models/WorkflowCheckpointModel';
import { AgentJobRetentionRepository } from '../app/Repositories/AgentJobRetentionRepository';
import { DesktopPostgresConnection } from '../app/Database/DesktopPostgresConnection';
import { postgresClient } from '../database/PostgresClient';

/** Periodically drain bounded batches of expired, non-resumable database history. */
export class DatabaseRetentionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly sentLedger = new SubjectMemorySentModel();
  // The repository needs the live Postgres connection; built lazily on the first pass.
  private agentJobsRepository: AgentJobRetentionRepository | undefined;
  private get agentJobs(): AgentJobRetentionRepository {
    return this.agentJobsRepository ??= new AgentJobRetentionRepository(new DesktopPostgresConnection(postgresClient));
  }

  initialize(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), 60 * 60 * 1000);
    (this.timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async drainBatches(deleteBatch: () => Promise<number>, limit: number, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const deleted = await deleteBatch();
      if (deleted < limit) return;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const deadline = Date.now() + 20_000;
      await this.drainBatches(() => this.sentLedger.deleteExpiredBatch(), 500, deadline);
      await this.drainBatches(() => WorkflowCheckpointModel.deleteExpiredBatch(), 250, deadline);
      await this.agentJobs.drainExpired();
    } catch (error) {
      console.warn('[DatabaseRetention] Bounded retention pass failed:', error);
    } finally {
      this.running = false;
    }
  }
}

export const databaseRetentionService = new DatabaseRetentionService();
