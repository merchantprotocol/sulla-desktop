import { BaseModel } from '../BaseModel';
import { postgresClient } from '../PostgresClient';

interface WorkflowHistoryAttributes {
  id:                 number;
  workflow_id:        string;
  definition_before:  Record<string, unknown> | null;
  definition_after:   Record<string, unknown>;
  changed_by:         string | null;
  change_reason:      string | null;
  created_at:         Date;
}

export class WorkflowHistoryModel extends BaseModel<WorkflowHistoryAttributes> {
  protected readonly tableName = 'workflow_history';
  protected readonly primaryKey = 'id';
  protected readonly timestamps = false;

  protected readonly fillable = [
    'workflow_id',
    'definition_before',
    'definition_after',
    'changed_by',
    'change_reason',
  ];

  protected readonly casts: Record<string, string> = {
    definition_before: 'json',
    definition_after:  'json',
    created_at:        'timestamp',
  };

  /**
   * Append a history row. Called by WorkflowModel on every definition change.
   * Failures are logged and swallowed — the audit trail is best-effort and must
   * never block a user's save.
   */
  static async recordChange(params: {
    workflowId:       string;
    definitionBefore: Record<string, unknown> | null;
    definitionAfter:  Record<string, unknown>;
    changedBy?:       string | null;
    changeReason?:    string | null;
  }): Promise<void> {
    try {
      await postgresClient.query(
        `INSERT INTO workflow_history
           (workflow_id, definition_before, definition_after, changed_by, change_reason)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)`,
        [
          params.workflowId,
          params.definitionBefore ? JSON.stringify(params.definitionBefore) : null,
          JSON.stringify(params.definitionAfter),
          params.changedBy ?? null,
          params.changeReason ?? null,
        ],
      );
    } catch (err) {
      console.warn('[WorkflowHistoryModel] Failed to record history:', err);
    }
  }

  /**
   * Get the change history for a workflow, most recent first.
   */
  static async findByWorkflow(
    workflowId: string,
    limit = 50,
  ): Promise<WorkflowHistoryModel[]> {
    const rows = await postgresClient.queryAll(
      `SELECT * FROM workflow_history
       WHERE workflow_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workflowId, limit],
    );
    return rows.map((row: any) => {
      const model = new WorkflowHistoryModel();
      model.databaseFill(row);
      return model;
    });
  }
}
