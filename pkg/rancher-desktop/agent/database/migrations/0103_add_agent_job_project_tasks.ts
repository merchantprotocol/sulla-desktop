/**
 * Migration 0103 — record which Projects tasks an agent job owns.
 *
 * A job launched for a task holds that task for its whole run, so the
 * dispatcher (and any other session) can see the owner mechanically instead of
 * guessing from job results that stay empty until the job finishes.
 */
export const up = `
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS project_task_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS project_task_prior_assignees JSONB NOT NULL DEFAULT '{}'::jsonb;

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_running_project_tasks
    ON agent_jobs USING GIN (project_task_ids)
    WHERE status = 'running';
`;

export const down = `
  DROP INDEX IF EXISTS idx_agent_jobs_running_project_tasks;
  ALTER TABLE agent_jobs
    DROP COLUMN IF EXISTS project_task_prior_assignees,
    DROP COLUMN IF EXISTS project_task_ids;
`;
