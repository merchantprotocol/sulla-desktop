/**
 * Durable ownership for the mechanical Projects dispatcher.
 *
 * A partial unique index makes "one live worker per task" a database
 * invariant instead of an LLM convention. Finished rows remain as the audit
 * trail; only running rows participate in the collision guard.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS work_task_dispatches (
    id          TEXT        PRIMARY KEY,
    task_id     TEXT        NOT NULL REFERENCES work_tasks(id),
    agent_id    TEXT        NOT NULL,
    thread_id   TEXT        NOT NULL,
    status      TEXT        NOT NULL DEFAULT 'running',
    result      TEXT,
    error       TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_task_dispatches_one_live
    ON work_task_dispatches (task_id)
    WHERE status = 'running';

  CREATE INDEX IF NOT EXISTS idx_work_task_dispatches_live
    ON work_task_dispatches (status, heartbeat_at ASC);
`;

export const down = `DROP TABLE IF EXISTS work_task_dispatches CASCADE;`;
