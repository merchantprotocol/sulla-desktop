/** Scoped lane automation bindings and immutable lane-entry snapshots. */

export const up = `
  CREATE TABLE IF NOT EXISTS work_lane_workflow_bindings (
    id                TEXT        PRIMARY KEY,
    profile_id        TEXT        NOT NULL DEFAULT 'default',
    scope             TEXT        NOT NULL CHECK (scope IN ('epic', 'project', 'global', 'core')),
    epic_id           TEXT        REFERENCES work_epics(id),
    project_id        TEXT        REFERENCES work_projects(id),
    lane_key          TEXT,
    semantic_role     TEXT,
    workflow_id       TEXT        NOT NULL REFERENCES workflows(id),
    lane_contract     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    active            BOOLEAN     NOT NULL DEFAULT true,
    archived          BOOLEAN     NOT NULL DEFAULT false,
    created_by        TEXT,
    updated_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ,
    archived_at       TIMESTAMPTZ,
    CONSTRAINT work_lane_workflow_binding_scope_check CHECK (
      (scope = 'epic' AND epic_id IS NOT NULL AND project_id IS NULL AND lane_key IS NOT NULL)
      OR (scope = 'project' AND epic_id IS NULL AND project_id IS NOT NULL AND lane_key IS NOT NULL)
      OR (scope = 'global' AND epic_id IS NULL AND project_id IS NULL AND (lane_key IS NOT NULL OR semantic_role IS NOT NULL))
      OR (scope = 'core' AND epic_id IS NULL AND project_id IS NULL AND semantic_role IS NOT NULL)
    ),
    CONSTRAINT work_lane_workflow_binding_lane_check CHECK (
      lane_key IS NULL OR length(lane_key) >= 1
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_lane_workflow_bindings_active_scope
    ON work_lane_workflow_bindings (
      profile_id, scope, COALESCE(epic_id, ''), COALESCE(project_id, ''),
      COALESCE(lane_key, ''), COALESCE(semantic_role, '')
    ) WHERE active = true AND archived = false;

  CREATE INDEX IF NOT EXISTS idx_work_lane_workflow_bindings_resolution
    ON work_lane_workflow_bindings (profile_id, scope, lane_key, semantic_role)
    WHERE active = true AND archived = false;

  CREATE TABLE IF NOT EXISTS work_lane_entry_automations (
    id                  TEXT        PRIMARY KEY,
    task_id             TEXT        NOT NULL REFERENCES work_tasks(id),
    generation          INTEGER     NOT NULL CHECK (generation > 0),
    previous_lane_key   TEXT,
    lane_key            TEXT        NOT NULL,
    binding_id          TEXT        REFERENCES work_lane_workflow_bindings(id),
    workflow_id         TEXT        REFERENCES workflows(id),
    resolution_source   TEXT        NOT NULL CHECK (resolution_source IN ('epic', 'project', 'global', 'core', 'manual', 'none')),
    fallback_reason     TEXT,
    binding_snapshot    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    workflow_snapshot   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    execution_id        TEXT,
    status              TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'unautomated')),
    outcome             JSONB,
    actor               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    UNIQUE (task_id, generation)
  );

  CREATE INDEX IF NOT EXISTS idx_work_lane_entry_automations_task
    ON work_lane_entry_automations (task_id, generation DESC);
`;

export const down = `
  DROP TABLE IF EXISTS work_lane_entry_automations CASCADE;
  DROP TABLE IF EXISTS work_lane_workflow_bindings CASCADE;
`;
