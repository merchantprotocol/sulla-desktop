/** Structured, independently resolvable custody receipts for review entry. */
export const up = `
  CREATE TABLE IF NOT EXISTS work_task_artifact_custody (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES work_tasks(id),
    dispatch_id   TEXT REFERENCES work_task_dispatches(id),
    custody_status TEXT NOT NULL CHECK (custody_status IN ('validated', 'legacy')),
    receipt       JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_work_task_artifact_custody_task
    ON work_task_artifact_custody (task_id, created_at DESC);

  INSERT INTO work_task_artifact_custody (id, task_id, dispatch_id, custody_status, receipt)
  SELECT 'legacy-custody-' || t.id, t.id, d.id, 'legacy',
         jsonb_build_object('legacy', true, 'reason', 'pre-0078 in_review record')
    FROM work_tasks t
    LEFT JOIN LATERAL (
      SELECT id FROM work_task_dispatches
       WHERE task_id = t.id
       ORDER BY started_at DESC NULLS LAST
       LIMIT 1
    ) d ON true
   WHERE t.status = 'in_review'
  ON CONFLICT (id) DO NOTHING;
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_task_artifact_custody_task;
  DROP TABLE IF EXISTS work_task_artifact_custody;
`;
