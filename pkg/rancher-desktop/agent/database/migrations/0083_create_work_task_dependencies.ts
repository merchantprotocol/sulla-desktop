/**
 * Migration 0083 — first-class task dependencies that mechanically gate
 * planning, execution, review, and lane-entry claims.
 *
 * A row means `dependent_task_id` depends on `depends_on_task_id`. Rows are
 * soft-archived (archived_at) so attribution and removal history survive.
 * Self-links and cycles are rejected transactionally in the model
 * (WorkTaskDependencyModel.create) via a recursive reachability check; the
 * partial unique index below enforces one active relation per pair+type. The
 * CHECK constraints below are DB-level belt-and-suspenders for the same rules.
 * This migration depends on work_tasks (migration 0044).
 */

export const up = `
  DO $$
  BEGIN
    IF to_regclass('work_tasks') IS NULL THEN
      RAISE EXCEPTION 'migration 0083 requires work_tasks from migration 0044';
    END IF;
  END $$;

  CREATE TABLE IF NOT EXISTS work_task_dependencies (
    id                   TEXT        PRIMARY KEY,
    dependent_task_id    TEXT        NOT NULL REFERENCES work_tasks(id),
    depends_on_task_id   TEXT        NOT NULL REFERENCES work_tasks(id),
    relation_type        TEXT        NOT NULL DEFAULT 'requires',
    acceptance_condition TEXT,
    created_by           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at          TIMESTAMPTZ,
    CONSTRAINT work_task_dependencies_no_self
      CHECK (dependent_task_id <> depends_on_task_id),
    CONSTRAINT work_task_dependencies_relation_type
      CHECK (relation_type IN ('blocks', 'requires', 'ordered-after'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_wtd_active_unique
    ON work_task_dependencies (dependent_task_id, depends_on_task_id, relation_type)
    WHERE archived_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_wtd_dependent_lookup
    ON work_task_dependencies (dependent_task_id, archived_at);
  CREATE INDEX IF NOT EXISTS idx_wtd_depends_on_lookup
    ON work_task_dependencies (depends_on_task_id, archived_at);
`;

export const down = `
  DROP TABLE IF EXISTS work_task_dependencies CASCADE;
`;
