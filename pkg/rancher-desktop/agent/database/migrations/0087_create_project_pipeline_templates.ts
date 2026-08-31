/** First-class reusable project pipeline templates, including the bundled locked default. */
export const up = `
  CREATE TABLE IF NOT EXISTS work_project_pipeline_templates (
    id TEXT PRIMARY KEY,
    template_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    system BOOLEAN NOT NULL DEFAULT false,
    locked BOOLEAN NOT NULL DEFAULT false,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    CONSTRAINT work_project_pipeline_templates_core_lock CHECK (NOT system OR locked)
  );

  CREATE TABLE IF NOT EXISTS work_project_pipeline_template_stages (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES work_project_pipeline_templates(id) ON DELETE CASCADE,
    stage_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    semantic_role TEXT,
    bundled_workflow_id TEXT,
    entry_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    wip_limit INTEGER CHECK (wip_limit IS NULL OR wip_limit > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    UNIQUE (template_id, stage_key),
    UNIQUE (template_id, position)
  );

  ALTER TABLE work_projects
    ADD COLUMN IF NOT EXISTS pipeline_template_id TEXT
      REFERENCES work_project_pipeline_templates(id);

  CREATE INDEX IF NOT EXISTS idx_work_project_pipeline_template_stages_order
    ON work_project_pipeline_template_stages (template_id, position, stage_key);

  INSERT INTO work_project_pipeline_templates (
    id, template_key, name, description, version, system, locked, enabled, created_by
  ) VALUES (
    'core-project-template-default',
    'core-default-project',
    'Sulla Default Project',
    'Bundled configurable project pipeline using Sulla Desktop core planning, execution, and review workflows.',
    1, true, true, true, 'core-seeder'
  ) ON CONFLICT (id) DO UPDATE SET
    template_key = EXCLUDED.template_key,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    version = EXCLUDED.version,
    system = true,
    locked = true,
    enabled = true,
    updated_at = now(),
    archived_at = NULL;

  INSERT INTO work_project_pipeline_template_stages (
    id, template_id, stage_key, display_name, description, position,
    semantic_role, bundled_workflow_id, entry_policy
  ) VALUES
    ('core-stage-backlog', 'core-project-template-default', 'backlog', 'Backlog', 'Prioritized work not yet ready to start.', 0, 'backlog', NULL, '{}'::jsonb),
    ('core-stage-planning', 'core-project-template-default', 'planning', 'Planning', 'Independent planning and recovery.', 10, 'planning', 'core-routine-plan-project-task', '{"successTransition":{"mode":"next"},"exceptionTransition":{"mode":"specific"}}'::jsonb),
    ('core-stage-todo', 'core-project-template-default', 'todo', 'To Do', 'Ready work selected for autonomous execution.', 20, 'execution', 'core-routine-execute-project-todo', '{"successTransition":{"mode":"next"},"exceptionTransition":{"mode":"specific"}}'::jsonb),
    ('core-stage-in-progress', 'core-project-template-default', 'in_progress', 'In Progress', 'Work with an active execution lease.', 30, 'execution', NULL, '{}'::jsonb),
    ('core-stage-in-review', 'core-project-template-default', 'in_review', 'In Review', 'Independent verification of the authoritative artifact.', 40, 'review', 'core-routine-review-project-artifact', '{"requiresCustody":true,"successTransition":{"mode":"next"},"exceptionTransition":{"mode":"specific"}}'::jsonb),
    ('core-stage-done', 'core-project-template-default', 'done', 'Done', 'Accepted terminal outcome.', 50, 'terminal', NULL, '{"requiresEvidence":true}'::jsonb),
    ('core-stage-blocked', 'core-project-template-default', 'blocked', 'Blocked', 'Explicit exception stage selected when work cannot advance.', 60, 'blocked', 'core-routine-plan-project-task', '{}'::jsonb),
    ('core-stage-parked', 'core-project-template-default', 'parked', 'Parked', 'Intentionally paused work.', 70, 'manual', NULL, '{}'::jsonb),
    ('core-stage-cancelled', 'core-project-template-default', 'cancelled', 'Cancelled', 'Cancelled terminal outcome.', 80, 'terminal', NULL, '{}'::jsonb)
  ON CONFLICT (id) DO UPDATE SET
    stage_key = EXCLUDED.stage_key,
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    position = EXCLUDED.position,
    semantic_role = EXCLUDED.semantic_role,
    bundled_workflow_id = EXCLUDED.bundled_workflow_id,
    entry_policy = EXCLUDED.entry_policy,
    updated_at = now();
`;

export const down = `
  ALTER TABLE work_projects DROP COLUMN IF EXISTS pipeline_template_id;
  DROP TABLE IF EXISTS work_project_pipeline_template_stages;
  DROP TABLE IF EXISTS work_project_pipeline_templates;
`;
