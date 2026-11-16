// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface QueryResult {
  rows:     any[];
  rowCount: number | null;
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

/**
 * workflow_executions access for AbandonedRunReaper: the candidate scan, the
 * per-execution launch advisory lock, and the compare-and-swap that settles a run.
 *
 * Timestamp columns are read and compared as Postgres text: a JS Date keeps only
 * milliseconds while timestamptz stores microseconds, so comparing through a Date
 * never matched and expired-lease runs stayed "running" forever.
 */
export class AbandonedRunRepository {
  constructor(private readonly db: Queryable) {}

  /** Running/suspended executions at this location that may have lost their owner. */
  async candidates(managerStartedAt: Date, location: string, leaseGraceSeconds: number, workflowId?: string): Promise<any[]> {
    const params: unknown[] = [managerStartedAt, location, leaseGraceSeconds];
    const workflowFilter = workflowId ? `AND e.workflow_id=$${ params.push(workflowId) }` : '';

    return (await this.db.query(
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

  /** Takes the launch lock for one execution on the given session; false when someone else holds it. */
  async tryLaunchLock(client: Queryable, lockKey: string): Promise<boolean> {
    return (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lockKey])).rows[0]?.acquired === true;
  }

  async releaseLaunchLock(client: Queryable, lockKey: string): Promise<void> {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
  }

  /** Marks the run failed only if it is still exactly the row that was inspected. */
  async failIfUnchanged(client: Queryable, row: any, reason: string): Promise<QueryResult> {
    return client.query(
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
  }
}
