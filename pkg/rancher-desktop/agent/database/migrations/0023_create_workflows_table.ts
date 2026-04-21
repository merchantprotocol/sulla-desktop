export const up = `
  CREATE TABLE IF NOT EXISTS workflows (
    id              VARCHAR(255) PRIMARY KEY,
    name            VARCHAR(500) NOT NULL,
    description     TEXT,
    version         VARCHAR(50),
    status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'production', 'archive')),
    definition      JSONB NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_workflows_status     ON workflows(status);
  CREATE INDEX IF NOT EXISTS idx_workflows_enabled    ON workflows(enabled);
  CREATE INDEX IF NOT EXISTS idx_workflows_definition ON workflows USING GIN (definition);

  CREATE TABLE IF NOT EXISTS workflow_history (
    id                  BIGSERIAL PRIMARY KEY,
    workflow_id         VARCHAR(255) NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    definition_before   JSONB,
    definition_after    JSONB NOT NULL,
    changed_by          VARCHAR(255),
    change_reason       TEXT,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_history_workflow ON workflow_history(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_history_created  ON workflow_history(created_at DESC);
`;

export const down = `
  DROP TABLE IF EXISTS workflow_history CASCADE;
  DROP TABLE IF EXISTS workflows CASCADE;
`;
