import { BaseModel } from '../BaseModel';
import { postgresClient } from '../PostgresClient';

interface WorkflowExecutionAttributes {
  execution_id:  string;
  workflow_id:   string;
  workflow_name: string;
  workflow_slug: string;
  status:        'running' | 'suspended' | 'completed' | 'failed';
  auto_restart:  boolean;
  trigger_input: string | null;
  started_at:    Date;
  completed_at:  Date | null;
  error:         string | null;
  created_at:    Date;
  updated_at:    Date;
}

export class WorkflowExecutionModel extends BaseModel<WorkflowExecutionAttributes> {
  protected readonly tableName  = 'workflow_executions';
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
    executionId:  string;
    workflowId:   string;
    workflowName: string;
    workflowSlug: string;
    autoRestart?: boolean;
    triggerInput?: string;
  }): Promise<void> {
    await postgresClient.query(
      `INSERT INTO workflow_executions
         (execution_id, workflow_id, workflow_name, workflow_slug, status, auto_restart, trigger_input, started_at, updated_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6, NOW(), NOW())
       ON CONFLICT (execution_id) DO UPDATE
         SET status = 'running', updated_at = NOW()`,
      [
        params.executionId,
        params.workflowId,
        params.workflowName,
        params.workflowSlug,
        params.autoRestart ?? true,
        params.triggerInput ?? null,
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
      `UPDATE workflow_executions
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE execution_id = $1`,
      [executionId],
    );
  }

  static async markFailed(executionId: string, error?: string): Promise<void> {
    await postgresClient.query(
      `UPDATE workflow_executions
       SET status = 'failed', completed_at = NOW(), error = $2, updated_at = NOW()
       WHERE execution_id = $1`,
      [executionId, error ?? null],
    );
  }

  /** Find all suspended executions, newest first. Used by boot recovery. */
  static async findSuspended(): Promise<WorkflowExecutionModel[]> {
    const rows = await postgresClient.queryAll(
      `SELECT * FROM workflow_executions
       WHERE status = 'suspended'
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
    m.databaseFill(row as any);
    return m;
  }
}
