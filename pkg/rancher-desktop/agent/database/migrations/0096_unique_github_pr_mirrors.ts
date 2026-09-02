/** Durable, opt-in GitHub PR projection ledger. No repositories are seeded here. */
export const up = `
  CREATE TABLE IF NOT EXISTS github_pr_project_mirrors (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'github' CHECK (provider = 'github'),
    owner TEXT NOT NULL CHECK (length(owner) > 0),
    repository TEXT NOT NULL CHECK (length(repository) > 0),
    pull_number INTEGER NOT NULL CHECK (pull_number > 0),
    task_id TEXT REFERENCES work_tasks(id),
    project_id TEXT NOT NULL REFERENCES work_projects(id),
    epic_id TEXT NOT NULL REFERENCES work_epics(id),
    parent_id TEXT REFERENCES work_tasks(id),
    snapshot_fingerprint TEXT,
    remote_updated_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_generation INTEGER NOT NULL DEFAULT 0 CHECK (sync_generation >= 0),
    remote_disposition TEXT NOT NULL DEFAULT 'unknown'
      CHECK (remote_disposition IN ('unknown', 'open', 'merged', 'closed_unmerged')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    CONSTRAINT github_pr_project_mirrors_identity
      UNIQUE (provider, owner, repository, pull_number)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_github_pr_project_mirrors_task
    ON github_pr_project_mirrors (task_id)
    WHERE task_id IS NOT NULL AND archived_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_github_pr_project_mirrors_refresh
    ON github_pr_project_mirrors (project_id, epic_id, remote_disposition, last_seen_at)
    WHERE archived_at IS NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_work_tasks_github_pr_mirror_identity
    ON work_tasks (source_ref)
    WHERE archived = false
      AND source = 'github-pr-mirror'
      AND source_ref LIKE 'github-pr:%';
`;

export const down = `
  DROP INDEX IF EXISTS uq_work_tasks_github_pr_mirror_identity;
  DROP TABLE IF EXISTS github_pr_project_mirrors;
`;
