export const up = `
  ALTER TABLE workflow_executions
    ADD COLUMN IF NOT EXISTS scope_task_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS scope_generation INTEGER;

  ALTER TABLE workflow_executions
    DROP CONSTRAINT IF EXISTS workflow_executions_scope_pair_check;
  ALTER TABLE workflow_executions
    ADD CONSTRAINT workflow_executions_scope_pair_check CHECK (
      (scope_task_id IS NULL AND scope_generation IS NULL)
      OR (scope_task_id IS NOT NULL AND scope_generation IS NOT NULL AND scope_generation > 0)
    );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_executions_active_lane_scope
    ON workflow_executions(workflow_id, scope_task_id, scope_generation)
    WHERE scope_task_id IS NOT NULL AND status IN ('running', 'suspended');
`;

export const down = `
  DROP INDEX IF EXISTS idx_wf_executions_active_lane_scope;
  ALTER TABLE workflow_executions DROP CONSTRAINT IF EXISTS workflow_executions_scope_pair_check;
  ALTER TABLE workflow_executions
    DROP COLUMN IF EXISTS scope_generation,
    DROP COLUMN IF EXISTS scope_task_id;
`;
