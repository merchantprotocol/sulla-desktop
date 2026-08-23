/**
 * Convert the legacy direct-chat actor alias into canonical dispatcher
 * ownership only for ordinary open queue work. The per-task comment is the
 * audit/rollback marker and makes the ownership change visible in Projects.
 */

import { NON_AUTONOMOUS_TASK_LABELS } from '../models/TaskOwnership';

export const OWNERSHIP_MIGRATION_COMMENT_PREFIX = 'ownership-0063:';
export const OWNERSHIP_MIGRATION_COMMENT = '[migration 0063] Normalized legacy assignee "sulla" to "dispatcher" because this todo is autonomous queue work. Undo: restore assignee to "sulla" for this task and archive this marker.';
const NON_AUTONOMOUS_LABEL_SQL = NON_AUTONOMOUS_TASK_LABELS.map(label => `'${ label }'`).join(', ');

export const up = `
  WITH converted AS (
    UPDATE work_tasks
       SET assignee = 'dispatcher',
           updated_at = now(),
           last_moved_at = now(),
           last_activity_at = now(),
           last_moved_by = 'dispatcher'
     WHERE archived = false
       AND status = 'todo'
       AND LOWER(COALESCE(assignee, '')) = 'sulla'
       AND NOT EXISTS (
         SELECT 1
           FROM unnest(COALESCE(labels, '{}')) AS label
          WHERE LOWER(label) = ANY(ARRAY[${ NON_AUTONOMOUS_LABEL_SQL }]::text[])
       )
    RETURNING id
  )
  INSERT INTO work_task_comments (id, task_id, body, author)
  SELECT '${ OWNERSHIP_MIGRATION_COMMENT_PREFIX }' || id,
         id,
         '${ OWNERSHIP_MIGRATION_COMMENT.replaceAll("'", "''") }',
         'system'
    FROM converted
  ON CONFLICT (id) DO NOTHING;
`;

export const down = `
  UPDATE work_tasks t
     SET assignee = 'sulla',
         updated_at = now(),
         last_moved_at = now(),
         last_activity_at = now(),
         last_moved_by = 'system'
    FROM work_task_comments c
   WHERE c.id = '${ OWNERSHIP_MIGRATION_COMMENT_PREFIX }' || t.id
     AND t.status = 'todo'
     AND LOWER(COALESCE(t.assignee, '')) = 'dispatcher';

  UPDATE work_task_comments
     SET archived = true, updated_at = now()
   WHERE id LIKE '${ OWNERSHIP_MIGRATION_COMMENT_PREFIX }%';
`;
