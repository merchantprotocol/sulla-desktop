import { BaseModel } from '../BaseModel';
import { postgresClient } from '../PostgresClient';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

interface WorkflowExecutionAttributes {
  execution_id:     string;
  workflow_id:      string;
  workflow_name:    string;
  workflow_slug:    string;
  status:           'running' | 'suspended' | 'completed' | 'failed';
  auto_restart:     boolean;
  trigger_input:    string | null;
  scope_task_id:    string | null;
  scope_generation: number | null;
  started_at:       Date;
  completed_at:     Date | null;
  error:            string | null;
  created_at:       Date;
  updated_at:       Date;
  owner_id:         string | null;
  lease_token:      string | null;
  leased_at:        Date | null;
  heartbeat_at:     Date | null;
  lease_expires_at: Date | null;
  attempt_count:    number;
  max_attempts:     number;
  terminal_at:      Date | null;
  terminal_reason:  string | null;
}

export class WorkflowExecutionModel extends BaseModel<WorkflowExecutionAttributes> {
  protected readonly tableName = 'workflow_executions';
  protected readonly primaryKey = 'execution_id';
  protected readonly timestamps = false;

  protected readonly fillable = [
    'execution_id',
    'workflow_id',
    'workflow_name',
    'workflow_slug',
    'status',
    'auto_restart',
    'trigger_input',
    'scope_task_id',
    'scope_generation',
    'started_at',
    'completed_at',
    'error',
    'owner_id', 'lease_token', 'leased_at', 'heartbeat_at', 'lease_expires_at',
    'attempt_count', 'max_attempts', 'terminal_at', 'terminal_reason',
  ];

  protected readonly casts: Record<string, string> = {
    auto_restart: 'boolean',
    started_at:   'timestamp',
    completed_at: 'timestamp',
    created_at:   'timestamp',
    updated_at:   'timestamp',
    leased_at: 'timestamp', heartbeat_at: 'timestamp', lease_expires_at: 'timestamp', terminal_at: 'timestamp',
    attempt_count: 'integer', max_attempts: 'integer',
  };

  /** Record a new execution as running. Safe to call multiple times — upserts. */
  static async markRunning(params: {
    executionId:      string;
    workflowId:       string;
    workflowName:     string;
    workflowSlug:     string;
    autoRestart?:     boolean;
    triggerInput?:    string;
    scopeTaskId?:     string;
    scopeGeneration?: number;
  }, client: PoolClient = postgresClient as unknown as PoolClient): Promise<void> {
    await client.query(
      `INSERT INTO workflow_executions
         (execution_id, workflow_id, workflow_name, workflow_slug, status, auto_restart, trigger_input,
          scope_task_id, scope_generation, started_at, updated_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (execution_id) DO UPDATE
         SET workflow_id = EXCLUDED.workflow_id,
             workflow_name = EXCLUDED.workflow_name,
             workflow_slug = EXCLUDED.workflow_slug,
             status = 'running', auto_restart = EXCLUDED.auto_restart,
             trigger_input = EXCLUDED.trigger_input,
             scope_task_id = EXCLUDED.scope_task_id,
             scope_generation = EXCLUDED.scope_generation,
             started_at = NOW(), completed_at = NULL, error = NULL, updated_at = NOW()`,
      [
        params.executionId,
        params.workflowId,
        params.workflowName,
        params.workflowSlug,
        params.autoRestart ?? true,
        params.triggerInput ?? null,
        params.scopeTaskId ?? null,
        params.scopeGeneration ?? null,
      ],
    );
  }

  /** Graceful shutdown: mark as suspended so boot recovery can find it. */
  static async markSuspended(executionId: string): Promise<void> {
    await postgresClient.query(
      `UPDATE workflow_executions SET status = 'suspended', lease_expires_at = NOW(), updated_at = NOW() WHERE execution_id = $1`,
      [executionId],
    );
  }

  /** Suspend every execution that is still in 'running' state. Called during app shutdown. */
  static async suspendAllRunning(): Promise<string[]> {
    const rows = await postgresClient.queryAll(
      `UPDATE workflow_executions
       SET status = 'suspended', updated_at = NOW()
           , lease_expires_at = NOW()
       WHERE status = 'running'
       RETURNING execution_id`,
      [],
    );
    return rows.map((r: any) => r.execution_id as string);
  }

  static async markCompleted(executionId: string): Promise<void> {
    await WorkflowExecutionModel.settle(executionId, 'completed');
  }

  private static hydrate(row: any): WorkflowExecutionModel {
    const model = new WorkflowExecutionModel();
    model.databaseFill(row);
    return model;
  }

  /** Atomically claim an unowned or expired execution. */
  static async acquireLease(executionId: string, ownerId: string, ttlMs: number, token = randomUUID()): Promise<WorkflowExecutionModel | null> {
    const row = await postgresClient.queryOne<any>(`UPDATE workflow_executions
      SET owner_id = $2, lease_token = $4, leased_at = COALESCE(leased_at, NOW()), heartbeat_at = NOW(),
          lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
      WHERE execution_id = $1 AND status IN ('running', 'suspended')
        AND (owner_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= NOW() OR (owner_id = $2 AND lease_token = $4))
      RETURNING *`, [executionId, ownerId, ttlMs, token]);
    return row ? WorkflowExecutionModel.hydrate(row) : null;
  }

  /** Renew only the lease held by this owner/token pair. */
  static async renewHeartbeat(executionId: string, ownerId: string, token: string, ttlMs: number): Promise<WorkflowExecutionModel | null> {
    const row = await postgresClient.queryOne<any>(`UPDATE workflow_executions
      SET heartbeat_at = NOW(), lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond'), updated_at = NOW()
      WHERE execution_id = $1 AND owner_id = $2 AND lease_token = $3 AND status IN ('running', 'suspended') RETURNING *`, [executionId, ownerId, token, ttlMs]);
    return row ? WorkflowExecutionModel.hydrate(row) : null;
  }

  static async releaseLease(executionId: string, ownerId: string, token: string): Promise<void> {
    await postgresClient.query(`UPDATE workflow_executions SET owner_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE execution_id = $1 AND owner_id = $2 AND lease_token = $3`, [executionId, ownerId, token]);
  }

  static async findStaleExecutions(now = new Date()): Promise<WorkflowExecutionModel[]> {
    const rows = await postgresClient.queryAll<any>(`SELECT * FROM workflow_executions WHERE status IN ('running', 'suspended') AND scope_task_id IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1 ORDER BY lease_expires_at ASC`, [now]);
    return rows.map(WorkflowExecutionModel.hydrate);
  }

  /** The dispatcher is the sole recovery authority for scoped executions. */
  static async reconcileDispatcherOwnedExecutions(): Promise<string[]> {
    return postgresClient.transaction(async(client) => {
      const rows = await client.query<{ execution_id: string }>(`
        WITH orphaned AS (
          SELECT execution.execution_id
          FROM workflow_executions execution
          LEFT JOIN work_task_dispatches dispatch
            ON dispatch.workflow_execution_id = execution.execution_id
          WHERE execution.scope_task_id IS NOT NULL
            AND execution.status IN ('running', 'suspended')
            AND (dispatch.id IS NULL OR dispatch.status <> 'running')
          FOR UPDATE OF execution
        ), settled AS (
          UPDATE workflow_executions execution
             SET status = 'failed', completed_at = COALESCE(completed_at, NOW()),
                 terminal_at = COALESCE(terminal_at, NOW()),
                 terminal_reason = 'dispatcher_parent_terminal_or_missing',
                 error = COALESCE(error, 'dispatcher parent dispatch is terminal or missing'),
                 owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
                 updated_at = NOW()
           WHERE execution.execution_id IN (SELECT execution_id FROM orphaned)
           RETURNING execution.execution_id
        )
        SELECT execution_id FROM settled`, []);
      const executionIds = rows.rows.map(row => row.execution_id);
      if (executionIds.length === 0) return [];
      await client.query(`UPDATE work_task_dispatches
        SET status = 'stale', failure_reason = COALESCE(failure_reason, 'dispatcher_workflow_execution_reconciled'),
            error = COALESCE(error, 'dispatcher workflow execution was reconciled'),
            heartbeat_at = NOW(), finished_at = COALESCE(finished_at, NOW())
        WHERE workflow_execution_id = ANY($1::text[]) AND status = 'running'`, [executionIds]);
      await client.query(`UPDATE work_lane_entry_automations
        SET status = 'failed',
            outcome = jsonb_build_object('disposition', 'runtime_failed', 'message', 'dispatcher workflow execution reconciled'),
            completed_at = COALESCE(completed_at, NOW())
        WHERE execution_id = ANY($1::text[]) AND status = 'running'`, [executionIds]);
      return executionIds;
    });
  }

  static async nextLeaseExpiry(): Promise<Date | null> {
    const row = await postgresClient.queryOne<{ next_expiry: Date | null }>(`
      SELECT MIN(lease_expires_at) AS next_expiry
      FROM workflow_executions
      WHERE status IN ('running', 'suspended') AND lease_expires_at IS NOT NULL`);
    return row?.next_expiry ? new Date(row.next_expiry) : null;
  }

  /** Claim one stale execution for recovery and return its last checkpoint. */
  static async recover(executionId: string, ownerId = `runtime-${ process.pid }`, ttlMs = 60000): Promise<{ execution: WorkflowExecutionModel; checkpoint: any | null } | null> {
    return postgresClient.transaction(async(client) => {
      // Deterministic across the recovery handoff: the first controller tick
      // must be able to renew the lease claimed by this recovery worker.
      const token = `${ ownerId }:${ executionId }`;
      const row = (await client.query(`UPDATE workflow_executions
        SET owner_id = $2, lease_token = $3, leased_at = NOW(), heartbeat_at = NOW(), lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond'), attempt_count = attempt_count + 1, updated_at = NOW()
        WHERE execution_id = $1 AND status IN ('running', 'suspended') AND lease_expires_at <= NOW() AND attempt_count < max_attempts RETURNING *`, [executionId, ownerId, token, ttlMs])).rows[0];
      if (!row) {
        await client.query(`WITH exhausted AS (
          UPDATE workflow_executions SET status = 'failed', completed_at = NOW(), terminal_at = NOW(),
            terminal_reason = 'recovery_attempt_ceiling', error = 'recovery attempt ceiling exceeded',
            owner_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE execution_id = $1 AND status IN ('running', 'suspended')
            AND lease_expires_at <= NOW() AND attempt_count >= max_attempts
          RETURNING execution_id
        ) UPDATE work_lane_entry_automations SET status = 'failed',
            outcome = jsonb_build_object('disposition', 'runtime_failed', 'message', 'recovery attempt ceiling exceeded'),
            completed_at = NOW()
          WHERE execution_id = (SELECT execution_id FROM exhausted) AND status = 'running'`, [executionId]);
        return null;
      }
      const checkpoint = (await client.query(`SELECT * FROM workflow_checkpoints WHERE execution_id = $1 ORDER BY sequence DESC LIMIT 1`, [executionId])).rows[0] ?? null;
      return { execution: WorkflowExecutionModel.hydrate(row), checkpoint };
    });
  }

  /** Terminal settlement is compare-and-set; repeated calls are no-ops. */
  static async settle(executionId: string, outcome: 'completed' | 'failed', error?: string): Promise<WorkflowExecutionModel | null> {
    const row = await postgresClient.queryOne<any>(`WITH settled AS (
      UPDATE workflow_executions SET status = $2::text, completed_at = COALESCE(completed_at, NOW()), terminal_at = COALESCE(terminal_at, NOW()), terminal_reason = CASE WHEN $2::text = 'failed' THEN COALESCE($3::text, terminal_reason) ELSE terminal_reason END, error = CASE WHEN $2::text = 'failed' THEN COALESCE($3::text, error) ELSE error END, owner_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE execution_id = $1 AND status IN ('running', 'suspended') RETURNING *),
      lane_settled AS (
      UPDATE work_lane_entry_automations
      SET status = $2::text, outcome = CASE WHEN $2::text = 'completed' THEN jsonb_build_object('disposition', 'completed') ELSE jsonb_build_object('disposition', 'runtime_failed', 'message', COALESCE($3::text, 'Unknown workflow failure')) END, completed_at = NOW()
      WHERE execution_id = (SELECT execution_id FROM settled) AND status = 'running'
      RETURNING execution_id)
      SELECT * FROM settled;`, [executionId, outcome, error ?? null]);
    return row ? WorkflowExecutionModel.hydrate(row) : null;
  }

  static async markFailed(executionId: string, error?: string): Promise<void> {
    await WorkflowExecutionModel.settle(executionId, 'failed', error);
  }

  /** Retire a source run only when it is still active. Restart must not
   * rewrite completed/failed history, but it also must not leave a zombie
   * eligible for the concurrent-run guard or boot recovery. */
  static async markSupersededIfActive(executionId: string): Promise<void> {
    await postgresClient.query(
      `UPDATE workflow_executions
       SET status = 'failed', completed_at = NOW(), error = 'superseded_by_checkpoint_restart', updated_at = NOW()
       WHERE execution_id = $1 AND status IN ('running', 'suspended')`,
      [executionId],
    );
  }

  /** Find all suspended executions, newest first. Used by boot recovery. */
  static async findSuspended(): Promise<WorkflowExecutionModel[]> {
    const rows = await postgresClient.queryAll(
      `SELECT * FROM workflow_executions
       WHERE status = 'suspended' AND scope_task_id IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
       ORDER BY started_at DESC`,
      [],
    );
    return rows.map((row: any) => {
      const m = new WorkflowExecutionModel();
      m.databaseFill(row);
      return m;
    });
  }

  /**
   * Find the most recent execution for a workflow, regardless of status.
   * Used by catch_up_schedules to decide whether a scheduled fire was missed.
   */
  static async findLatestByWorkflow(workflowId: string): Promise<WorkflowExecutionModel | null> {
    const row = await postgresClient.queryOne(
      `SELECT * FROM workflow_executions
       WHERE workflow_id = $1
       ORDER BY started_at DESC LIMIT 1`,
      [workflowId],
    );
    if (!row) return null;
    const m = new WorkflowExecutionModel();
    m.databaseFill(row);
    return m;
  }

  /**
   * Find any active (running or suspended) execution for a workflow.
   * Used for concurrent-run guard.
   */
  static async findActiveByWorkflow(workflowId: string): Promise<WorkflowExecutionModel | null> {
    const row = await postgresClient.queryOne(
      `SELECT * FROM workflow_executions
       WHERE workflow_id = $1 AND status IN ('running', 'suspended')
       ORDER BY started_at DESC LIMIT 1`,
      [workflowId],
    );
    if (!row) return null;
    const m = new WorkflowExecutionModel();
    m.databaseFill(row);
    return m;
  }

  /**
   * Find a conflicting active execution for a lane-scoped activation.
   * A different task/generation is allowed to run concurrently, while an
   * ordinary unscoped run retains exclusive ownership of the workflow.
   */
  static async findActiveByLaneScope(workflowId: string, taskId: string, generation: number):
  Promise<WorkflowExecutionModel | null> {
    const row = await postgresClient.queryOne(
      `SELECT * FROM workflow_executions
       WHERE workflow_id = $1 AND status IN ('running', 'suspended')
         AND (scope_task_id IS NULL OR (scope_task_id = $2 AND scope_generation = $3))
       ORDER BY started_at DESC LIMIT 1`,
      [workflowId, taskId, generation],
    );
    if (!row) return null;
    const m = new WorkflowExecutionModel();
    m.databaseFill(row);
    return m;
  }
}
