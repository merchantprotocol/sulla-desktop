// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SubjectMemorySentModel } from '../database/models/SubjectMemorySentModel';
import { WorkflowCheckpointModel } from '../database/models/WorkflowCheckpointModel';

/** Periodically drain bounded batches of expired, non-resumable database history. */
export class DatabaseRetentionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly sentLedger = new SubjectMemorySentModel();

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

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sentLedger.deleteExpiredBatch();
      await WorkflowCheckpointModel.deleteExpiredBatch();
    } catch (error) {
      console.warn('[DatabaseRetention] Bounded retention pass failed:', error);
    } finally {
      this.running = false;
    }
  }
}

export const databaseRetentionService = new DatabaseRetentionService();
