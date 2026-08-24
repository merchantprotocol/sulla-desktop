/**
 * Settle durable waits when a blocked task is replanned or reactivated (#715).
 *
 * Migration 0065 already settles active waits when a task reaches a terminal
 * status (`cancel_work_task_waits_from_terminal_task`) and reroutes human
 * comments / human task mutations back to review. What it does NOT cover is the
 * system reactivating a blocked task into an active lane — replanning, stale
 * recovery, or a dispatcher move out of `blocked` into `planning` / `todo` /
 * `in_progress` / `in_review` / `backlog`. Those waits stayed `active`, so the
 * external wait monitor kept polling a gate the task no longer waits on.
 *
 * This trigger settles every active wait the moment a task leaves `blocked` for
 * a non-terminal, non-blocked status, so replanning and reactivation settle the
 * wait exactly once across every protected lifecycle routine. Terminal
 * transitions remain owned by `cancel_work_task_waits_from_terminal_task`.
 */

export const up = `
  CREATE OR REPLACE FUNCTION settle_work_task_waits_on_replan()
  RETURNS trigger AS $$
  BEGIN
    IF OLD.status = 'blocked'
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status NOT IN ('blocked', 'done', 'cancelled', 'parked') THEN
      UPDATE work_task_waits
         SET status = 'cancelled',
             last_error = 'task left blocked state for ' || NEW.status,
             updated_at = now(),
             completed_at = now()
       WHERE task_id = NEW.id
         AND status = 'active';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_settle_work_task_waits_on_replan ON work_tasks;
  CREATE TRIGGER trg_settle_work_task_waits_on_replan
    AFTER UPDATE OF status ON work_tasks
    FOR EACH ROW EXECUTE FUNCTION settle_work_task_waits_on_replan();
`;

export const down = `
  DROP TRIGGER IF EXISTS trg_settle_work_task_waits_on_replan ON work_tasks;
  DROP FUNCTION IF EXISTS settle_work_task_waits_on_replan();
`;
