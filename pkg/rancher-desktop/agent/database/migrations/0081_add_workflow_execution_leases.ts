/** Durable ownership and heartbeat lease for workflow executions. */
export const up = `
  ALTER TABLE workflow_executions
    ADD COLUMN IF NOT EXISTS owner_id TEXT,
    ADD COLUMN IF NOT EXISTS lease_token TEXT,
    ADD COLUMN IF NOT EXISTS leased_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS terminal_reason TEXT;

  CREATE INDEX IF NOT EXISTS idx_wf_executions_stale_lease
    ON workflow_executions (lease_expires_at)
    WHERE status IN ('running', 'suspended') AND lease_expires_at IS NOT NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_wf_executions_stale_lease;
  ALTER TABLE workflow_executions
    DROP COLUMN IF EXISTS terminal_reason,
    DROP COLUMN IF EXISTS terminal_at,
    DROP COLUMN IF EXISTS max_attempts,
    DROP COLUMN IF EXISTS attempt_count,
    DROP COLUMN IF EXISTS lease_expires_at,
    DROP COLUMN IF EXISTS heartbeat_at,
    DROP COLUMN IF EXISTS leased_at,
    DROP COLUMN IF EXISTS lease_token,
    DROP COLUMN IF EXISTS owner_id;
`;
