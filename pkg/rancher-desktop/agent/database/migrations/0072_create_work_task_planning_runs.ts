/**
 * Durable ownership and audit history for Projects planning councils.
 *
 * The partial unique index makes one active council per task a database
 * invariant. Terminal rows remain as an append-only execution history.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS work_task_planning_runs (
    id            TEXT        PRIMARY KEY,
    task_id       TEXT        NOT NULL REFERENCES work_tasks(id),
    workflow_id   TEXT        NOT NULL,
    execution_id  TEXT,
    status        TEXT        NOT NULL DEFAULT 'active',
    trigger_status TEXT       NOT NULL,
    trigger_actor TEXT,
    attempt       INTEGER     NOT NULL DEFAULT 1,
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_task_planning_runs_one_active
    ON work_task_planning_runs (task_id)
    WHERE status = 'active';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_task_planning_runs_execution
    ON work_task_planning_runs (execution_id)
    WHERE execution_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_work_task_planning_runs_recovery
    ON work_task_planning_runs (status, heartbeat_at ASC);
`;

export const down = `DROP TABLE IF EXISTS work_task_planning_runs CASCADE;`;
