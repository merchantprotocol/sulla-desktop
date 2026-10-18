export const up = `
  ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS owner_issuer TEXT,
    ADD COLUMN IF NOT EXISTS owner_subject TEXT,
    ADD COLUMN IF NOT EXISTS authority_id UUID,
    ADD COLUMN IF NOT EXISTS organization_id UUID;
  ALTER TABLE workflow_executions
    ADD COLUMN IF NOT EXISTS owner_issuer TEXT,
    ADD COLUMN IF NOT EXISTS owner_subject TEXT,
    ADD COLUMN IF NOT EXISTS authority_id UUID,
    ADD COLUMN IF NOT EXISTS organization_id UUID,
    ADD COLUMN IF NOT EXISTS delegated_grant_token TEXT,
    ADD COLUMN IF NOT EXISTS delegated_grant_workflow_id TEXT,
    ADD COLUMN IF NOT EXISTS schedule_node_id TEXT;
  ALTER TABLE workflow_history
    ADD COLUMN IF NOT EXISTS owner_issuer TEXT,
    ADD COLUMN IF NOT EXISTS owner_subject TEXT,
    ADD COLUMN IF NOT EXISTS authority_id UUID,
    ADD COLUMN IF NOT EXISTS organization_id UUID;

  DO $$ BEGIN ALTER TABLE workflows ADD CONSTRAINT workflows_owner_pair_check CHECK ((owner_issuer IS NULL) = (owner_subject IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE workflows ADD CONSTRAINT workflows_tenant_pair_check CHECK ((authority_id IS NULL) = (organization_id IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE workflow_executions ADD CONSTRAINT workflow_executions_owner_pair_check CHECK ((owner_issuer IS NULL) = (owner_subject IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE workflow_executions ADD CONSTRAINT workflow_executions_tenant_pair_check CHECK ((authority_id IS NULL) = (organization_id IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE workflow_history ADD CONSTRAINT workflow_history_owner_pair_check CHECK ((owner_issuer IS NULL) = (owner_subject IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE workflow_history ADD CONSTRAINT workflow_history_tenant_pair_check CHECK ((authority_id IS NULL) = (organization_id IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(owner_issuer,owner_subject,authority_id,organization_id,updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_workflow_executions_owner ON workflow_executions(owner_issuer,owner_subject,authority_id,organization_id,started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_workflow_history_owner ON workflow_history(owner_issuer,owner_subject,authority_id,organization_id,created_at DESC);

  CREATE TABLE IF NOT EXISTS workflow_schedule_grants (
    workflow_id VARCHAR(255) NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    schedule_node_id TEXT NOT NULL,
    grant_id UUID NOT NULL UNIQUE,
    grant_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    owner_issuer TEXT NOT NULL,
    owner_subject TEXT NOT NULL,
    authority_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workflow_id, schedule_node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_schedule_grants_owner ON workflow_schedule_grants(owner_issuer,owner_subject,authority_id,organization_id,expires_at);
`;

export const down = `
  DROP TABLE IF EXISTS workflow_schedule_grants;
  DROP INDEX IF EXISTS idx_workflow_history_owner;
  DROP INDEX IF EXISTS idx_workflow_executions_owner;
  DROP INDEX IF EXISTS idx_workflows_owner;
  ALTER TABLE workflow_history DROP COLUMN IF EXISTS organization_id, DROP COLUMN IF EXISTS authority_id, DROP COLUMN IF EXISTS owner_subject, DROP COLUMN IF EXISTS owner_issuer;
  ALTER TABLE workflow_executions DROP COLUMN IF EXISTS schedule_node_id, DROP COLUMN IF EXISTS delegated_grant_workflow_id, DROP COLUMN IF EXISTS delegated_grant_token, DROP COLUMN IF EXISTS organization_id, DROP COLUMN IF EXISTS authority_id, DROP COLUMN IF EXISTS owner_subject, DROP COLUMN IF EXISTS owner_issuer;
  ALTER TABLE workflows DROP COLUMN IF EXISTS organization_id, DROP COLUMN IF EXISTS authority_id, DROP COLUMN IF EXISTS owner_subject, DROP COLUMN IF EXISTS owner_issuer;
`;
