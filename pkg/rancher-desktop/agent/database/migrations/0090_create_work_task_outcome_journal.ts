/**
 * Durable execution outcome outbox. A worker result is recorded before the
 * dispatcher attempts to settle the dispatch/task pair, so a process death
 * cannot turn a completed worker run into a lease expiry.
 */
export const up = `
  CREATE TABLE IF NOT EXISTS work_task_outcome_journal (
    id               TEXT PRIMARY KEY,
    dispatch_id      TEXT NOT NULL REFERENCES work_task_dispatches(id) ON DELETE CASCADE,
    task_id          TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    dispatch_status  TEXT NOT NULL,
    task_status      TEXT NOT NULL,
    task_assignee    TEXT NOT NULL,
    comment          TEXT NOT NULL,
    result           TEXT,
    error            TEXT,
    evidence         JSONB,
    receipt          JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at      TIMESTAMPTZ,
    UNIQUE (dispatch_id)
  );

  CREATE INDEX IF NOT EXISTS idx_work_task_outcome_journal_pending
    ON work_task_outcome_journal (created_at)
    WHERE consumed_at IS NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_task_outcome_journal_pending;
  DROP TABLE IF EXISTS work_task_outcome_journal;
`;
