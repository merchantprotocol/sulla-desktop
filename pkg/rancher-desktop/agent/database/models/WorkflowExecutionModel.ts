import { BaseModel } from '../BaseModel';
import { postgresClient } from '../PostgresClient';

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
  ];

  protected readonly casts: Record<string, string> = {
    auto_restart: 'boolean',
    started_at:   'timestamp',
    completed_at: 'timestamp',
    created_at:   'timestamp',
    updated_at:   'timestamp',
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
  }): Promise<void> {
    await postgresClient.query(
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
      `UPDATE workflow_executions SET status = 'suspended', updated_at = NOW() WHERE execution_id = $1`,
      [executionId],
    );
  }

  /** Suspend every execution that is still in 'running' state. Called during app shutdown. */
  static async suspendAllRunning(): Promise<string[]> {
    const rows = await postgresClient.queryAll(
      `UPDATE workflow_executions
       SET status = 'suspended', updated_at = NOW()
       WHERE status = 'running'
       RETURNING execution_id`,
      [],
    );
    return rows.map((r: any) => r.execution_id as string);
  }

  static async markCompleted(executionId: string): Promise<void> {
    await postgresClient.query(
      `WITH settled AS (
         UPDATE workflow_executions
            SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE execution_id = $1
          RETURNING execution_id
       )
       UPDATE work_lane_entry_automations
          SET status = 'completed', outcome = jsonb_build_object('disposition', 'completed'), completed_at = NOW()
        WHERE execution_id = (SELECT execution_id FROM settled) AND status = 'running'`,
      [executionId],
    );
  }

  static async markFailed(executionId: string, error?: string): Promise<void> {
    await postgresClient.query(
      `WITH settled AS (
         UPDATE workflow_executions
            SET status = 'failed', completed_at = NOW(), error = $2, updated_at = NOW()
          WHERE execution_id = $1
          RETURNING execution_id
       )
       UPDATE work_lane_entry_automations
          SET status = 'failed', outcome = jsonb_build_object(
            'disposition', 'runtime_failed', 'message', COALESCE($2, 'Unknown workflow failure')
          ), completed_at = NOW()
        WHERE execution_id = (SELECT execution_id FROM settled) AND status = 'running'`,
      [executionId, error ?? null],
    );
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
