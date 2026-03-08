export const up = `
  CREATE TABLE IF NOT EXISTS workflow_checkpoints (
    id              SERIAL PRIMARY KEY,
    execution_id    VARCHAR(255) NOT NULL,
    workflow_id     VARCHAR(255) NOT NULL,
    workflow_name   VARCHAR(500),
    node_id         VARCHAR(255) NOT NULL,
    node_label      VARCHAR(500),
    node_subtype    VARCHAR(100),
    sequence        INTEGER NOT NULL,
    playbook_state  JSONB NOT NULL,
    node_output     JSONB,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_execution ON workflow_checkpoints(execution_id);
  CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_workflow  ON workflow_checkpoints(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_exec_seq  ON workflow_checkpoints(execution_id, sequence);
`;

export const down = `DROP TABLE IF EXISTS workflow_checkpoints CASCADE;`;
