export const up = `
  CREATE TABLE IF NOT EXISTS workflow_executions (
    execution_id    VARCHAR(255) PRIMARY KEY,
    workflow_id     VARCHAR(255) NOT NULL,
    workflow_name   VARCHAR(500),
    workflow_slug   VARCHAR(255),
    status          VARCHAR(20) NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'suspended', 'completed', 'failed')),
    auto_restart    BOOLEAN NOT NULL DEFAULT true,
    trigger_input   TEXT,
    started_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMP WITH TIME ZONE,
    error           TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_wf_executions_workflow ON workflow_executions(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_wf_executions_status   ON workflow_executions(status);
  CREATE INDEX IF NOT EXISTS idx_wf_executions_started  ON workflow_executions(started_at DESC);
`;

export const down = `DROP TABLE IF EXISTS workflow_executions CASCADE;`;
