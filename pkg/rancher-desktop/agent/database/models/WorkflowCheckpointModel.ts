import { BaseModel } from '../BaseModel';
import { postgresClient } from '../PostgresClient';

interface WorkflowCheckpointAttributes {
  id:             number;
  execution_id:   string;
  workflow_id:    string;
  workflow_name:  string;
  node_id:        string;
  node_label:     string;
  node_subtype:   string;
  sequence:       number;
  playbook_state: Record<string, unknown>;
  node_output:    unknown;
  created_at:     Date;
}

export class WorkflowCheckpointModel extends BaseModel<WorkflowCheckpointAttributes> {
  protected readonly tableName = 'workflow_checkpoints';
  protected readonly primaryKey = 'id';
  protected readonly timestamps = false;

  protected readonly fillable = [
    'execution_id',
    'workflow_id',
    'workflow_name',
    'node_id',
    'node_label',
    'node_subtype',
    'sequence',
    'playbook_state',
    'node_output',
  ];

  protected readonly casts: Record<string, string> = {
    sequence:       'integer',
    playbook_state: 'json',
    node_output:    'json',
    created_at:     'timestamp',
  };

  /**
   * Get all checkpoints for an execution, ordered by sequence.
   */
  static async findByExecution(executionId: string): Promise<WorkflowCheckpointModel[]> {
    const rows = await postgresClient.queryAll(
      `SELECT * FROM workflow_checkpoints WHERE execution_id = $1 ORDER BY sequence ASC`,
      [executionId],
    );
    return rows.map((row: any) => {
      const model = new WorkflowCheckpointModel();
      model.databaseFill(row);
      return model;
    });
  }

  /**
   * Get the most recent executions for a workflow (latest checkpoint per execution).
   */
  static async recentExecutions(workflowId: string, limit = 10): Promise<WorkflowCheckpointModel[]> {
    const rows = await postgresClient.queryAll(
      `SELECT DISTINCT ON (execution_id) *
       FROM workflow_checkpoints
       WHERE workflow_id = $1
       ORDER BY execution_id, sequence DESC
       LIMIT $2`,
      [workflowId, limit],
    );
    return rows.map((row: any) => {
      const model = new WorkflowCheckpointModel();
      model.databaseFill(row);
      return model;
    });
  }

  /**
   * Get the checkpoint for a specific node in an execution.
   * Returns the checkpoint taken AFTER the node completed.
   */
  static async findByNode(executionId: string, nodeId: string): Promise<WorkflowCheckpointModel | null> {
    const row = await postgresClient.queryOne(
      `SELECT * FROM workflow_checkpoints WHERE execution_id = $1 AND node_id = $2 LIMIT 1`,
      [executionId, nodeId],
    );
    if (!row) return null;
    const model = new WorkflowCheckpointModel();
    model.databaseFill(row);
    return model;
  }

  /**
   * Get the checkpoint just BEFORE a given node (the previous node's checkpoint).
   * This is what you'd use to restart from that node — the state right before it ran.
   */
  static async findCheckpointBefore(executionId: string, nodeId: string): Promise<WorkflowCheckpointModel | null> {
    const targetCheckpoint = await WorkflowCheckpointModel.findByNode(executionId, nodeId);
    if (!targetCheckpoint) return null;

    const targetSeq = targetCheckpoint.attributes.sequence!;
    if (targetSeq <= 1) return null;

    const row = await postgresClient.queryOne(
      `SELECT * FROM workflow_checkpoints
       WHERE execution_id = $1 AND sequence < $2
       ORDER BY sequence DESC LIMIT 1`,
      [executionId, targetSeq],
    );
    if (!row) return null;

    const model = new WorkflowCheckpointModel();
    model.databaseFill(row);
    return model;
  }

  /**
   * Save a checkpoint for a completed node.
   */
  static async saveCheckpoint(params: {
    executionId:   string;
    workflowId:    string;
    workflowName:  string;
    nodeId:        string;
    nodeLabel:     string;
    nodeSubtype:   string;
    sequence:      number;
    playbookState: Record<string, unknown>;
    nodeOutput:    unknown;
  }): Promise<WorkflowCheckpointModel> {
    const checkpoint = new WorkflowCheckpointModel();
    checkpoint.attributes = {
      execution_id:   params.executionId,
      workflow_id:    params.workflowId,
      workflow_name:  params.workflowName,
      node_id:        params.nodeId,
      node_label:     params.nodeLabel,
      node_subtype:   params.nodeSubtype,
      sequence:       params.sequence,
      playbook_state: params.playbookState,
      node_output:    params.nodeOutput,
      created_at:     new Date(),
    } as any;
    await checkpoint.save();
    return checkpoint;
  }
}
