CREATE TABLE IF NOT EXISTS workflow_agent_runs (
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  invocation_id UUID NOT NULL UNIQUE,
  agent_run_id TEXT UNIQUE,
  owner_issuer TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  authority_id UUID,
  organization_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (execution_id, node_id)
);

DO $$ BEGIN
  ALTER TABLE workflow_agent_runs ADD CONSTRAINT workflow_agent_runs_tenant_pair_check
    CHECK ((authority_id IS NULL) = (organization_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_workflow_agent_runs_owner
  ON workflow_agent_runs(owner_issuer,owner_subject,authority_id,organization_id,created_at DESC);
