/**
 * Add the second, independently bounded dispatcher phase.
 *
 * The existing partial unique index remains the cross-kind collision guard:
 * one task can have at most one running execution OR verification lease.
 */

export const up = `
  ALTER TABLE work_task_dispatches
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'execution',
    ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS verdict TEXT,
    ADD COLUMN IF NOT EXISTS artifact_sha TEXT,
    ADD COLUMN IF NOT EXISTS failure_reason TEXT;

  ALTER TABLE work_task_dispatches
    DROP CONSTRAINT IF EXISTS work_task_dispatches_kind_check,
    DROP CONSTRAINT IF EXISTS work_task_dispatches_verdict_check;

  ALTER TABLE work_task_dispatches
    ADD CONSTRAINT work_task_dispatches_kind_check
      CHECK (kind IN ('execution', 'verification')),
    ADD CONSTRAINT work_task_dispatches_verdict_check
      CHECK (verdict IS NULL OR verdict IN ('APPROVE', 'REWORK', 'BLOCKED'));

  CREATE INDEX IF NOT EXISTS idx_work_task_dispatches_metrics
    ON work_task_dispatches (kind, status, started_at DESC);
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_task_dispatches_metrics;
  ALTER TABLE work_task_dispatches
    DROP CONSTRAINT IF EXISTS work_task_dispatches_verdict_check,
    DROP CONSTRAINT IF EXISTS work_task_dispatches_kind_check,
    DROP COLUMN IF EXISTS failure_reason,
    DROP COLUMN IF EXISTS artifact_sha,
    DROP COLUMN IF EXISTS verdict,
    DROP COLUMN IF EXISTS attempt,
    DROP COLUMN IF EXISTS kind;
`;
