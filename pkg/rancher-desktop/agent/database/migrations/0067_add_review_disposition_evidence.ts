/**
 * Durable evidence for the protected in-review disposition routine.
 *
 * work_task_dispatches remains the single lease ledger. These columns turn a
 * verification lease into an immutable review-generation record without
 * weakening the existing one-live-dispatch-per-task index.
 */
export const up = `
  ALTER TABLE work_task_dispatches
    ADD COLUMN IF NOT EXISTS origin_dispatch_id TEXT,
    ADD COLUMN IF NOT EXISTS origin_agent_id TEXT,
    ADD COLUMN IF NOT EXISTS origin_evidence JSONB,
    ADD COLUMN IF NOT EXISTS workflow_execution_id TEXT,
    ADD COLUMN IF NOT EXISTS reviewer_agent_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS review_artifact_type TEXT,
    ADD COLUMN IF NOT EXISTS review_artifact_ref TEXT,
    ADD COLUMN IF NOT EXISTS review_artifact_url TEXT,
    ADD COLUMN IF NOT EXISTS review_artifact_hash TEXT,
    ADD COLUMN IF NOT EXISTS review_checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS review_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS findings_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS disposition TEXT;

  ALTER TABLE work_task_dispatches
    DROP CONSTRAINT IF EXISTS work_task_dispatches_disposition_check;

  ALTER TABLE work_task_dispatches
    ADD CONSTRAINT work_task_dispatches_disposition_check
      CHECK (disposition IS NULL OR disposition IN
        ('PASS', 'REPAIRABLE', 'REPLAN', 'EXTERNAL_WAIT', 'BLOCKED'));

  CREATE INDEX IF NOT EXISTS idx_work_task_dispatches_review_generation
    ON work_task_dispatches (task_id, review_artifact_hash, started_at DESC)
    WHERE kind = 'verification';

  CREATE INDEX IF NOT EXISTS idx_work_task_dispatches_review_fingerprint
    ON work_task_dispatches (task_id, findings_fingerprint, started_at DESC)
    WHERE kind = 'verification' AND findings_fingerprint IS NOT NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_task_dispatches_review_fingerprint;
  DROP INDEX IF EXISTS idx_work_task_dispatches_review_generation;
  ALTER TABLE work_task_dispatches
    DROP CONSTRAINT IF EXISTS work_task_dispatches_disposition_check,
    DROP COLUMN IF EXISTS disposition,
    DROP COLUMN IF EXISTS findings_fingerprint,
    DROP COLUMN IF EXISTS review_findings,
    DROP COLUMN IF EXISTS review_checks,
    DROP COLUMN IF EXISTS review_artifact_hash,
    DROP COLUMN IF EXISTS review_artifact_url,
    DROP COLUMN IF EXISTS review_artifact_ref,
    DROP COLUMN IF EXISTS review_artifact_type,
    DROP COLUMN IF EXISTS reviewer_agent_ids,
    DROP COLUMN IF EXISTS workflow_execution_id,
    DROP COLUMN IF EXISTS origin_agent_id,
    DROP COLUMN IF EXISTS origin_evidence,
    DROP COLUMN IF EXISTS origin_dispatch_id;
`;
