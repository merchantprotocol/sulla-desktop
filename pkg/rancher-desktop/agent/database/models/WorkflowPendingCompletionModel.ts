import { BaseModel } from '../BaseModel';
import { postgresClient } from '../PostgresClient';

/**
 * Persists sub-agent completions, failures, and escalations so they survive
 * Graph instance restarts. The workflow walker drains these on every entry
 * instead of relying solely on in-memory arrays.
 *
 * kind: 'completion' | 'failure' | 'escalation'
 * status: 'pending' | 'drained'
 */
interface WorkflowPendingCompletionAttributes {
  id:             number;
  execution_id:   string;
  thread_id:      string | null;
  node_id:        string;
  node_label:     string;
  kind:           'completion' | 'failure' | 'escalation';
  status:         'pending' | 'drained';
  output:         unknown;
  error:          string | null;
  escalation:     Record<string, unknown> | null;
  created_at:     Date;
  drained_at:     Date | null;
}

export class WorkflowPendingCompletionModel extends BaseModel<WorkflowPendingCompletionAttributes> {
  protected readonly tableName = 'workflow_pending_completions';
  protected readonly primaryKey = 'id';
  protected readonly timestamps = false;

  protected readonly fillable = [
    'execution_id',
    'thread_id',
    'node_id',
    'node_label',
    'kind',
    'status',
    'output',
    'error',
    'escalation',
  ];

  protected readonly casts: Record<string, string> = {
    output:     'json',
    escalation: 'json',
    created_at: 'timestamp',
    drained_at: 'timestamp',
  };

  /**
   * Persist a sub-agent completion result.
   */
  static async saveCompletion(params: {
    executionId: string;
    nodeId:      string;
    nodeLabel:   string;
    output:      unknown;
    threadId?:   string;
  }): Promise<void> {
    try {
      const model = new WorkflowPendingCompletionModel();
      model.attributes = {
        execution_id: params.executionId,
        node_id:      params.nodeId,
        node_label:   params.nodeLabel,
        kind:         'completion',
        status:       'pending',
        output:       params.output,
        thread_id:    params.threadId ?? null,
        error:        null,
        escalation:   null,
        created_at:   new Date(),
        drained_at:   null,
      } as any;
      await model.save();
    } catch (err) {
      console.warn('[WorkflowPendingCompletionModel] Failed to save completion:', err);
    }
  }

  /**
   * Persist a sub-agent failure.
   */
  static async saveFailure(params: {
    executionId: string;
    nodeId:      string;
    nodeLabel:   string;
    error:       string;
  }): Promise<void> {
    try {
      const model = new WorkflowPendingCompletionModel();
      model.attributes = {
        execution_id: params.executionId,
        node_id:      params.nodeId,
        node_label:   params.nodeLabel,
        kind:         'failure',
        status:       'pending',
        output:       null,
        thread_id:    null,
        error:        params.error,
        escalation:   null,
        created_at:   new Date(),
        drained_at:   null,
      } as any;
      await model.save();
    } catch (err) {
      console.warn('[WorkflowPendingCompletionModel] Failed to save failure:', err);
    }
  }

  /**
   * Persist a sub-agent escalation (blocked agent asking a question).
   */
  static async saveEscalation(params: {
    executionId: string;
    nodeId:      string;
    nodeLabel:   string;
    agentId:     string;
    prompt:      string;
    config:      Record<string, unknown>;
    question:    string;
    threadId?:   string;
  }): Promise<void> {
    try {
      const model = new WorkflowPendingCompletionModel();
      model.attributes = {
        execution_id: params.executionId,
        node_id:      params.nodeId,
        node_label:   params.nodeLabel,
        kind:         'escalation',
        status:       'pending',
        output:       null,
        thread_id:    params.threadId ?? null,
        error:        null,
        escalation:   {
          agentId:  params.agentId,
          prompt:   params.prompt,
          config:   params.config,
          question: params.question,
        },
        created_at: new Date(),
        drained_at: null,
      } as any;
      await model.save();
    } catch (err) {
      console.warn('[WorkflowPendingCompletionModel] Failed to save escalation:', err);
    }
  }

  /**
   * Fetch all pending (undrained) records for an execution, ordered by creation.
   */
  static async findPending(executionId: string): Promise<WorkflowPendingCompletionModel[]> {
    const rows = await postgresClient.queryAll(
      `SELECT * FROM workflow_pending_completions
       WHERE execution_id = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [executionId],
    );
    return rows.map((row: any) => {
      const model = new WorkflowPendingCompletionModel();
      model.databaseFill(row);
      return model;
    });
  }

  /**
   * Mark a pending record as drained (processed by the walker).
   */
  static async markDrained(id: number): Promise<void> {
    await postgresClient.query(
      `UPDATE workflow_pending_completions SET status = 'drained', drained_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Mark all pending records for an execution as drained (bulk cleanup).
   */
  static async markAllDrained(executionId: string): Promise<void> {
    await postgresClient.query(
      `UPDATE workflow_pending_completions SET status = 'drained', drained_at = NOW()
       WHERE execution_id = $1 AND status = 'pending'`,
      [executionId],
    );
  }
}
