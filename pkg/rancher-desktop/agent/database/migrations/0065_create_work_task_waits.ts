/**
 * Durable external-wait ownership for Projects tasks.
 *
 * Active waits are unique per task/kind/target. Terminal rows remain as an
 * audit trail and do not prevent a later wait for the same target.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS work_task_waits (
    id                          TEXT        PRIMARY KEY,
    task_id                     TEXT        NOT NULL REFERENCES work_tasks(id),
    wait_kind                   TEXT        NOT NULL CHECK (wait_kind IN ('github_checks', 'human_gate', 'scheduled_time', 'external_job')),
    target_key                  TEXT        NOT NULL,
    target                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    last_observed_fingerprint   TEXT,
    next_check_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    owner                       TEXT        NOT NULL DEFAULT 'external-wait-monitor',
    status                      TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'changed', 'satisfied', 'cancelled', 'failed')),
    consecutive_unchanged_count INTEGER     NOT NULL DEFAULT 0,
    consecutive_failure_count   INTEGER     NOT NULL DEFAULT 0,
    first_checked_at            TIMESTAMPTZ,
    last_checked_at             TIMESTAMPTZ,
    last_error                  TEXT,
    due_at                      TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at                TIMESTAMPTZ
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_task_waits_one_active_target
    ON work_task_waits (task_id, wait_kind, target_key)
    WHERE status = 'active';

  CREATE INDEX IF NOT EXISTS idx_work_task_waits_due
    ON work_task_waits (next_check_at ASC)
    WHERE status = 'active';

  CREATE INDEX IF NOT EXISTS idx_work_task_waits_task
    ON work_task_waits (task_id, status, updated_at DESC);

  CREATE OR REPLACE FUNCTION invalidate_work_task_waits_from_human_comment()
  RETURNS trigger AS $$
  BEGIN
    IF LOWER(COALESCE(NEW.author, '')) = 'human' THEN
      UPDATE work_task_waits
         SET status = 'changed',
             last_error = 'human comment invalidated wait',
             updated_at = now(),
             completed_at = now()
       WHERE task_id = NEW.task_id
         AND status = 'active';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_comment ON work_task_comments;
  CREATE TRIGGER trg_invalidate_work_task_waits_from_human_comment
    AFTER INSERT ON work_task_comments
    FOR EACH ROW EXECUTE FUNCTION invalidate_work_task_waits_from_human_comment();

  CREATE OR REPLACE FUNCTION invalidate_work_task_waits_from_human_task_mutation()
  RETURNS trigger AS $$
  BEGIN
    IF LOWER(COALESCE(NEW.last_moved_by, '')) = 'human'
       AND NEW.status NOT IN ('done', 'cancelled', 'parked') THEN
      UPDATE work_task_waits
         SET status = 'changed',
             last_error = 'human task mutation invalidated wait',
             updated_at = now(),
             completed_at = now()
       WHERE task_id = NEW.id
         AND status = 'active';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_task_mutation ON work_tasks;
  CREATE TRIGGER trg_invalidate_work_task_waits_from_human_task_mutation
    AFTER UPDATE ON work_tasks
    FOR EACH ROW EXECUTE FUNCTION invalidate_work_task_waits_from_human_task_mutation();

  CREATE OR REPLACE FUNCTION cancel_work_task_waits_from_terminal_task()
  RETURNS trigger AS $$
  BEGIN
    IF NEW.status IN ('done', 'cancelled', 'parked')
       AND OLD.status IS DISTINCT FROM NEW.status THEN
      UPDATE work_task_waits
         SET status = 'cancelled',
             last_error = 'task entered terminal status ' || NEW.status,
             updated_at = now(),
             completed_at = now()
       WHERE task_id = NEW.id
         AND status = 'active';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_cancel_work_task_waits_from_terminal_task ON work_tasks;
  CREATE TRIGGER trg_cancel_work_task_waits_from_terminal_task
    AFTER UPDATE OF status ON work_tasks
    FOR EACH ROW EXECUTE FUNCTION cancel_work_task_waits_from_terminal_task();
`;

export const down = `
  DROP TRIGGER IF EXISTS trg_cancel_work_task_waits_from_terminal_task ON work_tasks;
  DROP FUNCTION IF EXISTS cancel_work_task_waits_from_terminal_task();
  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_task_mutation ON work_tasks;
  DROP FUNCTION IF EXISTS invalidate_work_task_waits_from_human_task_mutation();
  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_comment ON work_task_comments;
  DROP FUNCTION IF EXISTS invalidate_work_task_waits_from_human_comment();
  DROP TABLE IF EXISTS work_task_waits CASCADE;
`;
