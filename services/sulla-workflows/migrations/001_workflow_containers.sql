ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'desktop'
    CHECK (location IN ('desktop', 'server'));

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS runner_id TEXT,
  ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS playbook_state JSONB,
  ADD COLUMN IF NOT EXISTS parent_execution_id TEXT,
  ADD COLUMN IF NOT EXISTS wait_kind TEXT,
  ADD COLUMN IF NOT EXISTS wait_payload JSONB,
  ADD COLUMN IF NOT EXISTS resume_input JSONB,
  ADD COLUMN IF NOT EXISTS trigger_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_executions_trigger_key
  ON workflow_executions(trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_executions_resume
  ON workflow_executions(resume_at) WHERE status = 'suspended';

CREATE TABLE IF NOT EXISTS workflow_execution_events (
  id BIGSERIAL PRIMARY KEY,
  execution_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  node_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_execution
  ON workflow_execution_events(execution_id, id);

CREATE TABLE IF NOT EXISTS workflow_run_tokens (
  token_hash TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
