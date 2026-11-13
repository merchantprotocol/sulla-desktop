// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

interface QueryResult {
  rows:     any[];
  rowCount: number | null;
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

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
 * Every settle is a compare-and-swap against the exact row that was inspected. The
 * timestamp columns are read and compared as Postgres text: a JS Date keeps only
 * milliseconds while timestamptz stores microseconds, so comparing through a Date
 * never matched and expired-lease runs stayed "running" forever.
 */
export class AbandonedRunReaper {
  readonly #options: AbandonedRunReaperOptions;
  readonly #leaseGraceSeconds: number;

  constructor(options: AbandonedRunReaperOptions) {
    this.#options = options;
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

  private async candidates(workflowId?: string): Promise<any[]> {
    const params: unknown[] = [this.#options.managerStartedAt, this.#options.location, this.#leaseGraceSeconds];
    const workflowFilter = workflowId ? `AND e.workflow_id=$${ params.push(workflowId) }` : '';

    return (await this.#options.db.query(
      `SELECT e.execution_id,e.status,e.runner_id,e.started_at,e.owner_id,e.lease_token,
              e.lease_expires_at,e.heartbeat_at::text AS heartbeat_at_exact,
              e.lease_expires_at::text AS lease_expires_at_exact,e.resume_at::text AS resume_at_exact,
              e.wait_kind,
              EXISTS (SELECT 1 FROM workflow_checkpoints c WHERE c.execution_id=e.execution_id) AS has_checkpoint
         FROM workflow_executions e JOIN workflows w ON w.id=e.workflow_id
        WHERE e.status IN ('running','suspended') AND w.location=$2
          ${ workflowFilter }
          AND NOT (e.status='suspended' AND e.wait_kind IS NOT NULL)
          AND (
            -- A runner was assigned but never took the lease.
            (e.runner_id IS NOT NULL AND e.owner_id IS NULL AND e.lease_token IS NULL AND e.heartbeat_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM workflow_checkpoints c WHERE c.execution_id=e.execution_id))
            OR
            -- Inserted by a manager that is gone before it launched anything.
            (e.runner_id IS NULL AND e.owner_id IS NULL AND e.lease_token IS NULL AND e.heartbeat_at IS NULL AND e.started_at < $1
              AND NOT EXISTS (SELECT 1 FROM workflow_checkpoints c WHERE c.execution_id=e.execution_id))
            OR
            -- Unowned and untouched since before this manager started (e.g. a resumed run
            -- whose launch was cut short by a manager restart).
            (e.owner_id IS NULL AND e.lease_token IS NULL AND e.updated_at < $1)
            OR
            -- The owning runner stopped heartbeating and its lease ran out.
            (e.lease_expires_at IS NOT NULL AND e.lease_expires_at <= NOW() - make_interval(secs => $3))
          )`, params,
    )).rows;
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
      const acquired = (await lockClient.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lockKey])).rows[0]?.acquired === true;
      if (!acquired) return false;
      reason = await this.reasonFor(row);
      if (!reason) return false;
      result = await lockClient.query(
        `UPDATE workflow_executions
            SET status='failed',auto_restart=FALSE,completed_at=COALESCE(completed_at,NOW()),
                terminal_at=COALESCE(terminal_at,NOW()),terminal_reason=$2,error=COALESCE(error,$2),
                runner_id=NULL,owner_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
          WHERE execution_id=$1 AND status=$3
            AND runner_id IS NOT DISTINCT FROM $4::text
            AND owner_id IS NOT DISTINCT FROM $5::text
            AND lease_token IS NOT DISTINCT FROM $6::text
            AND heartbeat_at IS NOT DISTINCT FROM $7::timestamptz
            AND lease_expires_at IS NOT DISTINCT FROM $8::timestamptz
            AND wait_kind IS NOT DISTINCT FROM $9::text
            AND resume_at IS NOT DISTINCT FROM $10::timestamptz
            AND (EXISTS (SELECT 1 FROM workflow_checkpoints c WHERE c.execution_id=workflow_executions.execution_id))=$11
            AND NOT (status='suspended' AND wait_kind IS NOT NULL)
          RETURNING workflow_id`, [
          row.execution_id, reason, row.status, row.runner_id ?? null, row.owner_id ?? null, row.lease_token ?? null,
          row.heartbeat_at_exact ?? null, row.lease_expires_at_exact ?? null, row.wait_kind ?? null, row.resume_at_exact ?? null,
          row.has_checkpoint === true,
        ],
      );
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => {});
      lockClient.release();
    }
    if (!reason || !result?.rowCount) return false;
    if (row.runner_id) await this.#options.launcher.stopRunner(row.runner_id).catch(() => {});
    await this.#options.emit(row.execution_id, result.rows[0].workflow_id, 'workflow_failed', { error: reason });

    return true;
  }
}
