/**
 * Migration 0094 — make async sub-agent completion delivery durable.
 *
 * The completion report and its graph wake target must survive the parent
 * process exiting between the worker finishing and the in-process callback.
 */
export const up = `
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS parent_channel TEXT,
    ADD COLUMN IF NOT EXISTS parent_thread_id TEXT,
    ADD COLUMN IF NOT EXISTS completion_delivered_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_pending_completion
    ON agent_jobs (status, completion_delivered_at)
    WHERE status = 'completed' AND completion_delivered_at IS NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_agent_jobs_pending_completion;
  ALTER TABLE agent_jobs
    DROP COLUMN IF EXISTS completion_delivered_at,
    DROP COLUMN IF EXISTS parent_thread_id,
    DROP COLUMN IF EXISTS parent_channel;
`;
