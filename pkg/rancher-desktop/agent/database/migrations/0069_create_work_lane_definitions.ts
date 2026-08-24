/**
 * First-class Projects lane definitions.
 *
 * This migration is intentionally schema-only. Default and legacy-status rows
 * are inserted by WorkLaneDefinitionSeeder at boot so install data never lands
 * in a shipped migration and work_tasks.status is never rewritten here.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS work_lane_definitions (
    id              TEXT        PRIMARY KEY,
    lane_key        TEXT        NOT NULL CHECK (length(lane_key) >= 1),
    scope           TEXT        NOT NULL CHECK (scope IN ('global_default', 'project')),
    project_id      TEXT        REFERENCES work_projects(id),
    base_lane_key   TEXT,
    display_name    TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    color           TEXT,
    icon            TEXT,
    position        INTEGER     NOT NULL DEFAULT 0,
    semantic_role   TEXT        NOT NULL CHECK (semantic_role IN (
      'backlog', 'planning', 'execution', 'review', 'blocked', 'terminal', 'manual'
    )),
    enabled         BOOLEAN     NOT NULL DEFAULT true,
    archived        BOOLEAN     NOT NULL DEFAULT false,
    system_required BOOLEAN     NOT NULL DEFAULT false,
    created_by      TEXT,
    updated_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    archived_at     TIMESTAMPTZ,
    reset_at        TIMESTAMPTZ,
    CONSTRAINT work_lane_scope_project_check CHECK (
      (scope = 'global_default' AND project_id IS NULL AND base_lane_key IS NULL)
      OR (scope = 'project' AND project_id IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_lane_definitions_active_key
    ON work_lane_definitions (scope, COALESCE(project_id, ''), lane_key)
    WHERE reset_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_work_lane_definitions_resolve
    ON work_lane_definitions (scope, project_id, reset_at, archived, enabled, position);
`;

export const down = `DROP TABLE IF EXISTS work_lane_definitions CASCADE;`;
