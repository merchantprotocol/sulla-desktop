/**
 * A task's activity timestamp is the deterministic round-robin cursor used by
 * Heartbeat. Any task edit or comment advances it; models never set it.
 */

export const up = `
  ALTER TABLE work_tasks
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

  UPDATE work_tasks t
     SET last_activity_at = GREATEST(
       t.last_moved_at,
       COALESCE(t.updated_at, t.last_moved_at),
       COALESCE((
         SELECT MAX(c.created_at)
           FROM work_task_comments c
          WHERE c.task_id = t.id AND c.archived = false
       ), t.last_moved_at)
     )
   WHERE t.last_activity_at IS NULL;

  ALTER TABLE work_tasks
    ALTER COLUMN last_activity_at SET DEFAULT now(),
    ALTER COLUMN last_activity_at SET NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_work_tasks_activity
    ON work_tasks (archived, status, priority, last_activity_at ASC);
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_tasks_activity;
  ALTER TABLE work_tasks DROP COLUMN IF EXISTS last_activity_at;
`;
