import type { Client } from 'pg';

export async function up(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE work_epics ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
    ALTER TABLE work_epics ADD COLUMN IF NOT EXISTS milestone_at TIMESTAMPTZ;
    ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
    ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS milestone_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS work_task_dependencies (
      task_id TEXT NOT NULL REFERENCES work_tasks(id),
      depends_on_task_id TEXT NOT NULL REFERENCES work_tasks(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT NOT NULL DEFAULT 'sulla',
      archived BOOLEAN NOT NULL DEFAULT false,
      CHECK (task_id <> depends_on_task_id),
      PRIMARY KEY (task_id, depends_on_task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_task_dependencies_reverse
      ON work_task_dependencies(depends_on_task_id) WHERE archived = false;

    CREATE TABLE IF NOT EXISTS work_project_views (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES work_projects(id),
      name TEXT NOT NULL DEFAULT 'Default',
      view_type TEXT NOT NULL CHECK (view_type IN ('board', 'table', 'gantt', 'calendar', 'list')),
      configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT NOT NULL DEFAULT 'human',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      archived BOOLEAN NOT NULL DEFAULT false
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_project_views_default_scope
      ON work_project_views(COALESCE(project_id, ''), is_default)
      WHERE is_default = true AND archived = false;

    CREATE TABLE IF NOT EXISTS work_schedule_audit (
      id BIGSERIAL PRIMARY KEY,
      item_kind TEXT NOT NULL CHECK (item_kind IN ('epic', 'task')),
      item_id TEXT NOT NULL,
      field_name TEXT NOT NULL CHECK (field_name IN ('start_at', 'due_at', 'milestone_at')),
      old_value TIMESTAMPTZ,
      new_value TIMESTAMPTZ,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_work_schedule_audit_item
      ON work_schedule_audit(item_kind, item_id, created_at DESC);
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS work_schedule_audit;
    DROP TABLE IF EXISTS work_project_views;
    DROP TABLE IF EXISTS work_task_dependencies;
    ALTER TABLE work_tasks DROP COLUMN IF EXISTS milestone_at;
    ALTER TABLE work_tasks DROP COLUMN IF EXISTS start_at;
    ALTER TABLE work_epics DROP COLUMN IF EXISTS milestone_at;
    ALTER TABLE work_epics DROP COLUMN IF EXISTS start_at;
  `);
}
