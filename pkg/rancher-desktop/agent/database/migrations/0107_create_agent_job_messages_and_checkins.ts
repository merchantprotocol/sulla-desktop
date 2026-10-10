/** Durable orchestrator messages and worker milestone check-ins for spawn_agent jobs. */
export const up = `
  CREATE TABLE IF NOT EXISTS agent_job_messages (
    id                  TEXT PRIMARY KEY,
    job_id              TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index          INTEGER NOT NULL CHECK (task_index >= 0),
    message             TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at        TIMESTAMPTZ,
    delivery_thread_id  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_job_messages_pending
    ON agent_job_messages (job_id, task_index, created_at)
    WHERE delivered_at IS NULL;

  CREATE TABLE IF NOT EXISTS agent_job_checkins (
    id             BIGSERIAL PRIMARY KEY,
    job_id         TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index     INTEGER NOT NULL CHECK (task_index >= 0),
    step           TEXT NOT NULL,
    summary        TEXT NOT NULL,
    files_touched  JSONB NOT NULL DEFAULT '[]'::jsonb,
    blockers       JSONB NOT NULL DEFAULT '[]'::jsonb,
    percent        NUMERIC CHECK (percent >= 0 AND percent <= 100),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_agent_job_checkins_recent
    ON agent_job_checkins (job_id, task_index, created_at DESC);
`;

export const down = `
  DROP TABLE IF EXISTS agent_job_checkins;
  DROP TABLE IF EXISTS agent_job_messages;
`;
