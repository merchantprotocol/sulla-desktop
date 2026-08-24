/**
 * 0085_add_conveyor_metrics_indexes — additive, index-only migration that keeps
 * the Projects conveyor-health dashboard (issue #717) bounded on local Postgres.
 * No data is mutated and no columns/tables are dropped; every index uses
 * IF NOT EXISTS so re-running is safe.
 */
export const up = `
  -- verifier throughput / rework scans by dispatch kind over a finished-at window
  CREATE INDEX IF NOT EXISTS idx_wtd_kind_finished
    ON work_task_dispatches (kind, finished_at DESC);

  -- duplicate/suppressed review-generation dedup key (verification leases only)
  CREATE INDEX IF NOT EXISTS idx_wtd_verif_generation
    ON work_task_dispatches (task_id, review_generation_hash)
    WHERE kind = 'verification';

  -- custody completeness joins dispatches to their task by kind
  CREATE INDEX IF NOT EXISTS idx_wtd_task_kind
    ON work_task_dispatches (task_id, kind);

  -- independent-shipment / done-throughput window scans
  CREATE INDEX IF NOT EXISTS idx_work_tasks_completed
    ON work_tasks (project_id, completed_at)
    WHERE status = 'done';

  -- stage-age percentile window scans over recently-active tasks
  CREATE INDEX IF NOT EXISTS idx_work_tasks_activity
    ON work_tasks (project_id, last_activity_at)
    WHERE archived = false;
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_tasks_activity;
  DROP INDEX IF EXISTS idx_work_tasks_completed;
  DROP INDEX IF EXISTS idx_wtd_task_kind;
  DROP INDEX IF EXISTS idx_wtd_verif_generation;
  DROP INDEX IF EXISTS idx_wtd_kind_finished;
`;
