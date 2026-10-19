ALTER TABLE workflow_agent_runs ADD COLUMN IF NOT EXISTS occurrence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE workflow_agent_runs DROP CONSTRAINT IF EXISTS workflow_agent_runs_pkey;
ALTER TABLE workflow_agent_runs ADD PRIMARY KEY (execution_id, node_id, occurrence);
