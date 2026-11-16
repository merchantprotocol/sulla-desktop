// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AbandonedRunRepository, type QueryResult, type Queryable } from './Repositories/AbandonedRunRepository.js';

export type { Queryable } from './Repositories/AbandonedRunRepository.js';

export interface LockClient extends Queryable {
  release(): void;
}

export interface LockPool {
  connect(): Promise<LockClient>;
}

export interface RunnerProbe {
  runnerExists(runnerId: string): Promise<boolean>;
  stopRunner(runnerId: string): Promise<void>;
}

export type EmitWorkflowEvent = (executionId: string, workflowId: string, eventType: string, payload: Record<string, unknown>) => Promise<void>;

export interface AbandonedRunReaperOptions {
  db:               Queryable;
  lockPool:         LockPool;
  launcher:         RunnerProbe;
  emit:             EmitWorkflowEvent;
  /** Executions this manager is launching right now; they are never reaped. */
  isLaunching:      (executionId: string) => boolean;
  managerStartedAt: Date;
  /** The workflow location this manager serves (desktop or server). */
  location:         string;
  /** Extra time after a lease expires before the run is declared dead (runners heartbeat every 20 s). */
  leaseGraceSeconds?: number;
  now?:             () => number;
}

/**
 * Finds workflow executions that still say running/suspended but have no live owner,
 * and settles them as failed so they stop holding the workflow's concurrency slot.
 *
 * Every settle is a compare-and-swap against the exact row that was inspected
 * (see AbandonedRunRepository for why timestamps are compared as text).
 */
export class AbandonedRunReaper {
  readonly #options: AbandonedRunReaperOptions;
  readonly #leaseGraceSeconds: number;
  readonly #runs: AbandonedRunRepository;

  constructor(options: AbandonedRunReaperOptions, runs: AbandonedRunRepository = new AbandonedRunRepository(options.db)) {
    this.#options = options;
    this.#runs = runs;
    this.#leaseGraceSeconds = Math.max(0, Math.floor(options.leaseGraceSeconds ?? 60));
  }

  /** Settle every abandoned run (optionally for one workflow); returns the settled execution ids. */
  async reap(workflowId?: string): Promise<string[]> {
    const settled: string[] = [];
    for (const row of await this.candidates(workflowId)) {
      if (this.#options.isLaunching(row.execution_id)) continue;
      if (await this.settle(row)) settled.push(row.execution_id);
    }

    return settled;
  }

  private candidates(workflowId?: string): Promise<any[]> {
    return this.#runs.candidates(this.#options.managerStartedAt, this.#options.location, this.#leaseGraceSeconds, workflowId);
  }

  /** Why the row is abandoned, or null when it may still be alive. */
  private async reasonFor(row: any): Promise<string | null> {
    const now = this.#options.now?.() ?? Date.now();
    if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() + this.#leaseGraceSeconds * 1000 <= now) return 'runner_lease_expired';
    if (!row.runner_id) return 'manager_restarted_before_launch';
    if (new Date(row.started_at).getTime() < this.#options.managerStartedAt.getTime()) return 'manager_restarted_before_handshake';
    if (!await this.#options.launcher.runnerExists(row.runner_id)) return 'abandoned_without_live_runner';

    return null;
  }

  private async settle(row: any): Promise<boolean> {
    const lockKey = `workflow-launch:${ row.execution_id }`;
    const lockClient = await this.#options.lockPool.connect();
    let reason: string | null = null;
    let result: QueryResult | null = null;
    try {
      const acquired = await this.#runs.tryLaunchLock(lockClient, lockKey);
      if (!acquired) return false;
      reason = await this.reasonFor(row);
      if (!reason) return false;
      result = await this.#runs.failIfUnchanged(lockClient, row, reason);
    } finally {
      await this.#runs.releaseLaunchLock(lockClient, lockKey).catch(() => {});
      lockClient.release();
    }
    if (!reason || !result?.rowCount) return false;
    if (row.runner_id) await this.#options.launcher.stopRunner(row.runner_id).catch(() => {});
    await this.#options.emit(row.execution_id, result.rows[0].workflow_id, 'workflow_failed', { error: reason });

    return true;
  }
}
