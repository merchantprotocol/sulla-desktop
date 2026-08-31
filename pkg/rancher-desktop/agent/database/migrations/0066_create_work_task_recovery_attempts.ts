/**
 * Durable audit ledger for deterministic in-progress orphan recovery.
 *
 * Recovery comments are the human-readable audit trail. This table supplies
 * the monotonic attempt counter that prevents a repeatedly orphaned task from
 * cycling through the dispatcher forever.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS work_task_recovery_attempts (
    id                    TEXT        PRIMARY KEY,
    task_id               TEXT        NOT NULL REFERENCES work_tasks(id),
    attempt_number        INTEGER     NOT NULL,
    outcome               TEXT        NOT NULL,
    reason                TEXT        NOT NULL,
    previous_status       TEXT        NOT NULL,
    previous_assignee     TEXT,
    previous_activity_at  TIMESTAMPTZ NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, attempt_number)
  );

  CREATE INDEX IF NOT EXISTS idx_work_task_recovery_attempts_task
    ON work_task_recovery_attempts (task_id, attempt_number DESC);
`;

export const down = `DROP TABLE IF EXISTS work_task_recovery_attempts CASCADE;`;
