/** Shared database-side lane semantics for triggers and transactional consumers. */
export const up = `
  CREATE OR REPLACE FUNCTION resolve_work_task_lane_role(p_task_id TEXT, p_lane_key TEXT)
  RETURNS TEXT AS $$
  DECLARE
    resolved_role TEXT;
    catalog_ready BOOLEAN;
  BEGIN
    SELECT NOT EXISTS (
      SELECT required.role
        FROM unnest(ARRAY['backlog','planning','execution','review','blocked','terminal']::TEXT[]) required(role)
       WHERE NOT EXISTS (
         SELECT 1 FROM work_lane_definitions lane
          WHERE lane.scope = 'global_default' AND lane.reset_at IS NULL
            AND lane.archived = false AND lane.enabled = true
            AND lane.semantic_role = required.role
       )
    ) INTO catalog_ready;

    IF catalog_ready THEN
      SELECT lane.semantic_role INTO resolved_role
        FROM work_tasks task
        JOIN work_lane_definitions lane
          ON lane.lane_key = p_lane_key
         AND lane.reset_at IS NULL AND lane.archived = false AND lane.enabled = true
         AND (lane.scope = 'global_default'
           OR (lane.scope = 'project' AND lane.project_id = task.project_id))
       WHERE task.id = p_task_id
       ORDER BY CASE WHEN lane.scope = 'project' THEN 0 ELSE 1 END
       LIMIT 1;
      RETURN COALESCE(resolved_role, 'manual');
    END IF;

    RETURN CASE
      WHEN p_lane_key = 'backlog' THEN 'backlog'
      WHEN p_lane_key = 'planning' THEN 'planning'
      WHEN p_lane_key IN ('todo', 'in_progress') THEN 'execution'
      WHEN p_lane_key = 'in_review' THEN 'review'
      WHEN p_lane_key = 'blocked' THEN 'blocked'
      WHEN p_lane_key IN ('done', 'cancelled') THEN 'terminal'
      ELSE 'manual'
    END;
  END;
  $$ LANGUAGE plpgsql STABLE;

  CREATE OR REPLACE FUNCTION resolve_project_lane_key(
    p_project_id TEXT, p_role TEXT, p_compatibility_key TEXT, p_prefer_last BOOLEAN DEFAULT false
  ) RETURNS TEXT AS $$
  DECLARE
    resolved_key TEXT;
    catalog_ready BOOLEAN;
  BEGIN
    SELECT NOT EXISTS (
      SELECT required.role
        FROM unnest(ARRAY['backlog','planning','execution','review','blocked','terminal']::TEXT[]) required(role)
       WHERE NOT EXISTS (
         SELECT 1 FROM work_lane_definitions lane
          WHERE lane.scope = 'global_default' AND lane.reset_at IS NULL
            AND lane.archived = false AND lane.enabled = true
            AND lane.semantic_role = required.role
       )
    ) INTO catalog_ready;

    IF NOT catalog_ready THEN
      RETURN p_compatibility_key;
    END IF;

    SELECT effective.lane_key INTO resolved_key
      FROM (
        SELECT DISTINCT ON (lane.lane_key) lane.lane_key, lane.semantic_role, lane.position
          FROM work_lane_definitions lane
         WHERE lane.reset_at IS NULL AND lane.archived = false AND lane.enabled = true
           AND (lane.scope = 'global_default'
             OR (lane.scope = 'project' AND lane.project_id = p_project_id))
         ORDER BY lane.lane_key, CASE WHEN lane.scope = 'project' THEN 0 ELSE 1 END
      ) effective
     WHERE effective.semantic_role = p_role
     ORDER BY
       CASE WHEN p_prefer_last THEN -effective.position ELSE effective.position END,
       CASE WHEN effective.lane_key = p_compatibility_key THEN 0 ELSE 1 END,
       effective.lane_key
     LIMIT 1;
    RETURN COALESCE(resolved_key, p_compatibility_key);
  END;
  $$ LANGUAGE plpgsql STABLE;

  CREATE OR REPLACE FUNCTION invalidate_work_task_waits_from_human_comment()
  RETURNS trigger AS $$
  DECLARE task_project_id TEXT; task_status TEXT; review_key TEXT;
  BEGIN
    IF LOWER(COALESCE(NEW.author, '')) = 'human' THEN
      UPDATE work_task_waits SET status = 'changed', last_error = 'human comment invalidated wait',
        updated_at = now(), completed_at = now()
       WHERE task_id = NEW.task_id AND status = 'active';
      SELECT project_id, status INTO task_project_id, task_status FROM work_tasks WHERE id = NEW.task_id;
      review_key := resolve_project_lane_key(task_project_id, 'review', 'in_review');
      UPDATE work_tasks SET status = review_key, assignee = 'heartbeat', updated_at = now(),
        last_moved_at = now(), last_activity_at = now(), last_moved_by = 'external-wait-monitor'
       WHERE id = NEW.task_id AND resolve_work_task_lane_role(NEW.task_id, task_status) = 'blocked';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION invalidate_work_task_waits_from_human_task_mutation()
  RETURNS trigger AS $$
  DECLARE review_key TEXT;
  BEGIN
    IF LOWER(COALESCE(NEW.last_moved_by, '')) = 'human'
       AND resolve_work_task_lane_role(NEW.id, NEW.status) <> 'terminal' THEN
      UPDATE work_task_waits SET status = 'changed', last_error = 'human task mutation invalidated wait',
        updated_at = now(), completed_at = now()
       WHERE task_id = NEW.id AND status = 'active';
      review_key := resolve_project_lane_key(NEW.project_id, 'review', 'in_review');
      IF resolve_work_task_lane_role(NEW.id, NEW.status) = 'blocked' THEN
        NEW.status := review_key;
        NEW.assignee := 'heartbeat';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_task_mutation ON work_tasks;
  CREATE TRIGGER trg_invalidate_work_task_waits_from_human_task_mutation
    BEFORE UPDATE ON work_tasks FOR EACH ROW
    EXECUTE FUNCTION invalidate_work_task_waits_from_human_task_mutation();

  CREATE OR REPLACE FUNCTION cancel_work_task_waits_from_terminal_task()
  RETURNS trigger AS $$
  BEGIN
    IF resolve_work_task_lane_role(NEW.id, NEW.status) = 'terminal'
       AND OLD.status IS DISTINCT FROM NEW.status THEN
      UPDATE work_task_waits SET status = 'cancelled',
        last_error = 'task entered terminal lane ' || NEW.status,
        updated_at = now(), completed_at = now()
       WHERE task_id = NEW.id AND status = 'active';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

export const down = `
  CREATE OR REPLACE FUNCTION invalidate_work_task_waits_from_human_comment()
  RETURNS trigger AS $$
  BEGIN
    IF LOWER(COALESCE(NEW.author, '')) = 'human' THEN
      UPDATE work_task_waits
         SET status = 'changed', last_error = 'human comment invalidated wait',
             updated_at = now(), completed_at = now()
       WHERE task_id = NEW.task_id AND status = 'active';
      UPDATE work_tasks
         SET status = 'planning', assignee = 'dispatcher', updated_at = now(),
             last_moved_at = now(), last_activity_at = now(),
             last_moved_by = 'external-wait-monitor'
       WHERE id = NEW.task_id AND status = 'blocked';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION invalidate_work_task_waits_from_human_task_mutation()
  RETURNS trigger AS $$
  BEGIN
    IF LOWER(COALESCE(NEW.last_moved_by, '')) = 'human'
       AND NEW.status NOT IN ('done', 'cancelled', 'parked') THEN
      UPDATE work_task_waits
         SET status = 'changed', last_error = 'human task mutation invalidated wait',
             updated_at = now(), completed_at = now()
       WHERE task_id = NEW.id AND status = 'active';
      UPDATE work_tasks
         SET status = 'planning', assignee = 'dispatcher', updated_at = now(),
             last_moved_at = now(), last_activity_at = now(),
             last_moved_by = 'external-wait-monitor'
       WHERE id = NEW.id AND status = 'blocked';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_task_mutation ON work_tasks;
  CREATE TRIGGER trg_invalidate_work_task_waits_from_human_task_mutation
    AFTER UPDATE ON work_tasks FOR EACH ROW
    EXECUTE FUNCTION invalidate_work_task_waits_from_human_task_mutation();

  CREATE OR REPLACE FUNCTION cancel_work_task_waits_from_terminal_task()
  RETURNS trigger AS $$
  BEGIN
    IF NEW.status IN ('done', 'cancelled', 'parked')
       AND OLD.status IS DISTINCT FROM NEW.status THEN
      UPDATE work_task_waits
         SET status = 'cancelled', last_error = 'task entered terminal status ' || NEW.status,
             updated_at = now(), completed_at = now()
       WHERE task_id = NEW.id AND status = 'active';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP FUNCTION IF EXISTS resolve_project_lane_key(TEXT, TEXT, TEXT, BOOLEAN);
  DROP FUNCTION IF EXISTS resolve_work_task_lane_role(TEXT, TEXT);
`;
