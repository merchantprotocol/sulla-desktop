/** Additive concise artifact-receipt ledger (#716): compact, deduplicated
 * Projects receipts linked to full evidence stored on dispatch / workflow /
 * conversation records. No historical prose is migrated. */
export const up = `
CREATE TABLE IF NOT EXISTS work_artifact_receipts (
  id                    TEXT PRIMARY KEY,
  receipt_version       INTEGER     NOT NULL DEFAULT 1,
  task_id               TEXT        NOT NULL REFERENCES work_tasks (id) ON DELETE CASCADE,
  event_type            TEXT        NOT NULL,
  actor                 TEXT,
  workflow_execution_id TEXT,
  dispatch_id           TEXT,
  disposition           TEXT,
  next_owner            TEXT,
  validation_summary    TEXT,
  artifacts             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  content_hashes        TEXT[]      NOT NULL DEFAULT '{}',
  evidence_kind         TEXT,
  evidence_ref          TEXT,
  evidence_url          TEXT,
  fingerprint           TEXT        NOT NULL,
  comment_id            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_artifact_receipts_task_fingerprint
  ON work_artifact_receipts (task_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_work_artifact_receipts_task
  ON work_artifact_receipts (task_id);
CREATE INDEX IF NOT EXISTS idx_work_artifact_receipts_evidence
  ON work_artifact_receipts (evidence_kind, evidence_ref)
  WHERE evidence_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_artifact_receipts_hashes
  ON work_artifact_receipts USING gin (content_hashes);
`;

export const down = `
DROP INDEX IF EXISTS idx_work_artifact_receipts_hashes;
DROP INDEX IF EXISTS idx_work_artifact_receipts_evidence;
DROP INDEX IF EXISTS idx_work_artifact_receipts_task;
DROP INDEX IF EXISTS uq_work_artifact_receipts_task_fingerprint;
DROP TABLE IF EXISTS work_artifact_receipts;
`;
