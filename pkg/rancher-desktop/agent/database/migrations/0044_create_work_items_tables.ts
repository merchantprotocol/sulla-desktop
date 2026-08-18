/**
 * Migration 0044 — Create work-item tables (projects → epics → tasks → comments).
 *
 * Structured operator Projects in the desktop Postgres. This is NOT CRM
 * (CRM belongs in Sulla Cloud) and it is NOT the filesystem PRD registry
 * (`~/sulla/projects/** /PROJECT.md` via ProjectRegistry).
 *
 * Hierarchy:
 *   work_projects
 *     └── work_epics
 *           └── work_tasks (parent_id = subtask)
 *                 └── work_task_comments
 *
 * SCHEMA-ONLY (no-user-data-in-migrations rule). Any install-local ledger
 * markdown is imported at runtime by WorkItemsImportSeeder, which reads
 * THIS machine's ~/sulla/ledger/goals/ and never ships user rows.
 *
 * Extra columns (due_at / slug / source_ref / labels / assignee) exist so
 * the 8 work tools + ledger seeder can persist the fields they already send.
 *
 * Rows are NEVER hard-deleted — soft-archive via `archived`, mirroring
 * observations / sulla_rules.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS work_projects (
    id              TEXT        PRIMARY KEY,
    slug            TEXT        NOT NULL UNIQUE,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    outcome_metric  TEXT,
    status          TEXT        NOT NULL DEFAULT 'working',
    priority        TEXT        NOT NULL DEFAULT 'p2',
    owner           TEXT,
    due_at          TIMESTAMPTZ,
    source          TEXT,
    source_path     TEXT,
    source_ref      TEXT,
    github_repo     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    last_moved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived        BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE INDEX IF NOT EXISTS idx_work_projects_board
    ON work_projects (archived, status, priority, last_moved_at ASC);

  CREATE TABLE IF NOT EXISTS work_epics (
    id              TEXT        PRIMARY KEY,
    project_id      TEXT        NOT NULL REFERENCES work_projects(id),
    slug            TEXT,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'working',
    priority        TEXT        NOT NULL DEFAULT 'p2',
    position        INTEGER     NOT NULL DEFAULT 0,
    due_at          TIMESTAMPTZ,
    source          TEXT,
    source_ref      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    last_moved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived        BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE INDEX IF NOT EXISTS idx_work_epics_project
    ON work_epics (project_id, archived, position, status);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_epics_project_slug
    ON work_epics (project_id, slug)
    WHERE slug IS NOT NULL AND archived = false;

  CREATE TABLE IF NOT EXISTS work_tasks (
    id              TEXT        PRIMARY KEY,
    project_id      TEXT        NOT NULL REFERENCES work_projects(id),
    epic_id         TEXT        REFERENCES work_epics(id),
    parent_id       TEXT        REFERENCES work_tasks(id),
    slug            TEXT,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'todo',
    priority        TEXT        NOT NULL DEFAULT 'p2',
    assignee        TEXT,
    due_at          TIMESTAMPTZ,
    labels          TEXT[]      NOT NULL DEFAULT '{}',
    github_issue    TEXT,
    position        INTEGER     NOT NULL DEFAULT 0,
    source          TEXT,
    source_ref      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    last_moved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    archived        BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE INDEX IF NOT EXISTS idx_work_tasks_epic
    ON work_tasks (epic_id, archived, status, position);

  CREATE INDEX IF NOT EXISTS idx_work_tasks_project
    ON work_tasks (project_id, archived, status, priority, due_at);

  CREATE INDEX IF NOT EXISTS idx_work_tasks_parent
    ON work_tasks (parent_id) WHERE parent_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_work_tasks_due
    ON work_tasks (archived, due_at) WHERE due_at IS NOT NULL AND archived = false;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_tasks_epic_slug
    ON work_tasks (epic_id, slug)
    WHERE slug IS NOT NULL AND archived = false;

  CREATE TABLE IF NOT EXISTS work_task_comments (
    id              TEXT        PRIMARY KEY,
    task_id         TEXT        NOT NULL REFERENCES work_tasks(id),
    body            TEXT        NOT NULL,
    author          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    archived        BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE INDEX IF NOT EXISTS idx_work_task_comments_task
    ON work_task_comments (task_id, archived, created_at ASC);
`;

export const down = `
  DROP TABLE IF EXISTS work_task_comments CASCADE;
  DROP TABLE IF EXISTS work_tasks CASCADE;
  DROP TABLE IF EXISTS work_epics CASCADE;
  DROP TABLE IF EXISTS work_projects CASCADE;
`;
