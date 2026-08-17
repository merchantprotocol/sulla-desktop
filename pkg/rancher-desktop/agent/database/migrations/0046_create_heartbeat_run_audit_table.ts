// Durable heartbeat run-to-workboard audit trail.
//
// Heartbeat cycles already emit an in-memory event buffer, but the operator
// lane needs restart-proof evidence of which work item each run selected and
// whether the run completed, blocked, failed, or aborted. Schema-only: rows are
// populated at runtime by HeartbeatService.

export const up = `
  CREATE TABLE IF NOT EXISTS heartbeat_run_audit (
    run_id                       TEXT        PRIMARY KEY,
    started_at                   TIMESTAMPTZ NOT NULL,
    completed_at                 TIMESTAMPTZ,
    duration_ms                  INTEGER,
    event_type                   TEXT        NOT NULL DEFAULT 'started',
    status                       TEXT,
    status_note                  TEXT,
    blocker_reason               TEXT,
    error                        TEXT,
    cycle_count                  INTEGER,
    selected_project_id          TEXT,
    selected_epic_id             TEXT,
    selected_task_id             TEXT,
    selected_task_status         TEXT,
    selected_task_assignee       TEXT,
    selected_task_last_moved_at  TIMESTAMPTZ,
    selected_task_comment_count  INTEGER,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_heartbeat_run_audit_started_at
    ON heartbeat_run_audit (started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_heartbeat_run_audit_task
    ON heartbeat_run_audit (selected_task_id, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_heartbeat_run_audit_event_type
    ON heartbeat_run_audit (event_type, started_at DESC);
`;

export const down = `
  DROP TABLE IF EXISTS heartbeat_run_audit;
`;
