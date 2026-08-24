/** Additive execution provenance and artifact-custody ledger for core todo runs. */
export const up = `
  ALTER TABLE work_task_dispatches
    ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'legacy-worker',
    ADD COLUMN IF NOT EXISTS workflow_execution_id TEXT,
    ADD COLUMN IF NOT EXISTS classifier_decision JSONB,
    ADD COLUMN IF NOT EXISTS selected_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS worker_child_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS repair_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS artifact_type TEXT,
    ADD COLUMN IF NOT EXISTS artifact_location TEXT,
    ADD COLUMN IF NOT EXISTS artifact_url TEXT,
    ADD COLUMN IF NOT EXISTS artifact_ref TEXT,
    ADD COLUMN IF NOT EXISTS content_hash TEXT,
    ADD COLUMN IF NOT EXISTS reviewer_verdict TEXT,
    ADD COLUMN IF NOT EXISTS review_evidence JSONB,
    ADD COLUMN IF NOT EXISTS terminal_reason TEXT;

  CREATE INDEX IF NOT EXISTS idx_work_task_dispatches_workflow_execution
    ON work_task_dispatches (workflow_execution_id)
    WHERE workflow_execution_id IS NOT NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_task_dispatches_workflow_execution;
  ALTER TABLE work_task_dispatches
    DROP COLUMN IF EXISTS terminal_reason,
    DROP COLUMN IF EXISTS review_evidence,
    DROP COLUMN IF EXISTS reviewer_verdict,
    DROP COLUMN IF EXISTS content_hash,
    DROP COLUMN IF EXISTS artifact_ref,
    DROP COLUMN IF EXISTS artifact_url,
    DROP COLUMN IF EXISTS artifact_location,
    DROP COLUMN IF EXISTS artifact_type,
    DROP COLUMN IF EXISTS repair_count,
    DROP COLUMN IF EXISTS review_count,
    DROP COLUMN IF EXISTS attempt_count,
    DROP COLUMN IF EXISTS worker_child_ids,
    DROP COLUMN IF EXISTS selected_agents,
    DROP COLUMN IF EXISTS classifier_decision,
    DROP COLUMN IF EXISTS workflow_execution_id,
    DROP COLUMN IF EXISTS run_kind;
`;
