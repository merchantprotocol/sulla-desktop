/** Immutable evidence written in the same transaction as a protected task move. */
export const up = `
CREATE TABLE IF NOT EXISTS work_task_artifact_custody (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  transition  TEXT NOT NULL CHECK (transition IN ('in_review', 'done')),
  work_kind   TEXT NOT NULL CHECK (work_kind IN ('code', 'non_code')),
  custody     JSONB NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_task_artifact_custody_task
  ON work_task_artifact_custody (task_id, created_at DESC);
`;

export const down = `DROP TABLE IF EXISTS work_task_artifact_custody CASCADE;`;
