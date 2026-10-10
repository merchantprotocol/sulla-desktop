export const up = `
CREATE TABLE IF NOT EXISTS work_file_claims (
  id            TEXT PRIMARY KEY,
  repo_root     TEXT NOT NULL,
  path_glob     TEXT NOT NULL,
  owner_job_id  TEXT,
  owner_label   TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS work_file_claims_active_repo
  ON work_file_claims (repo_root, created_at)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS work_file_claims_active_owner_path
  ON work_file_claims (repo_root, path_glob, owner_label, worktree_path)
  WHERE released_at IS NULL;
`;

export const down = `DROP TABLE IF EXISTS work_file_claims;`;
