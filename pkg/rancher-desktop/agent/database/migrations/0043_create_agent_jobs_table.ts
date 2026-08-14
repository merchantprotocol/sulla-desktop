/**
 * Migration 0043 — Create agent_jobs table.
 *
 * Persists async sub-agent jobs (spawn_agent async mode) so an app
 * restart no longer silently loses every running job and its results.
 * The in-memory Map in tools/agents/jobRegistry.ts stays as the hot
 * cache; the registry writes through to this table on create/complete/
 * fail/stop and sweeps stale 'running' rows to 'failed' on first use
 * after boot — so check_agent_jobs answers honestly ("app restarted
 * mid-job") instead of "not found".
 *
 * SCHEMA-ONLY (per the no-user-data-in-migrations rule). Results are
 * stored as JSONB (label/status/output/threadId per task). Finished
 * jobs are pruned after the registry's TTL — this is operational state,
 * not history, so rows ARE deleted (unlike observations/rules).
 */

export const up = `
  CREATE TABLE IF NOT EXISTS agent_jobs (
    job_id      TEXT        PRIMARY KEY,
    status      TEXT        NOT NULL DEFAULT 'running',
    task_count  INTEGER     NOT NULL DEFAULT 0,
    results     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_status_created
    ON agent_jobs (status, created_at DESC);
`;

export const down = `DROP TABLE IF EXISTS agent_jobs CASCADE;`;
