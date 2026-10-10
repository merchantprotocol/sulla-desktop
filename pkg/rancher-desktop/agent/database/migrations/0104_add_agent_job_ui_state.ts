/**
 * Persist the display metadata needed by the chat's sub-agent rail.
 * Runtime state remains in jobRegistry's in-memory cache; these columns keep
 * cards linkable to their conversations across renderer/app reloads.
 */
export const up = `
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_parent_thread_visible
    ON agent_jobs (parent_thread_id, created_at DESC)
    WHERE parent_thread_id IS NOT NULL AND dismissed_at IS NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_agent_jobs_parent_thread_visible;
  ALTER TABLE agent_jobs
    DROP COLUMN IF EXISTS dismissed_at,
    DROP COLUMN IF EXISTS tasks;
`;
