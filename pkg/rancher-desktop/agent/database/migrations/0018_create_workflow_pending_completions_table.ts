export const up = `
  CREATE TABLE IF NOT EXISTS workflow_pending_completions (
    id              SERIAL PRIMARY KEY,
    execution_id    VARCHAR(255) NOT NULL,
    thread_id       VARCHAR(255),
    node_id         VARCHAR(255) NOT NULL,
    node_label      VARCHAR(500),
    kind            VARCHAR(50) NOT NULL DEFAULT 'completion',
    status          VARCHAR(50) NOT NULL DEFAULT 'pending',
    output          JSONB,
    error           TEXT,
    escalation      JSONB,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    drained_at      TIMESTAMP WITH TIME ZONE
  );

  CREATE INDEX IF NOT EXISTS idx_wf_pending_execution ON workflow_pending_completions(execution_id);
  CREATE INDEX IF NOT EXISTS idx_wf_pending_status    ON workflow_pending_completions(status);
  CREATE INDEX IF NOT EXISTS idx_wf_pending_exec_kind ON workflow_pending_completions(execution_id, kind, status);
`;

export const down = `DROP TABLE IF EXISTS workflow_pending_completions CASCADE;`;
