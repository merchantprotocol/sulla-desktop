/**
 * 0088_add_generation_to_artifact_receipts — additive, nullable column only.
 * dHAe Phase 5 workflow-node surface: attach_task_evidence records the
 * immutable stage-entry generation an evidence receipt was attached under, so
 * a generic evidence-receipt node stays generation-scoped the same way
 * transition_task_stage / transition_task_relative already are. Existing rows
 * are unaffected (generation stays NULL for pre-existing receipts); no data is
 * mutated and no columns/tables are dropped.
 */
export const up = `
  ALTER TABLE work_artifact_receipts
    ADD COLUMN IF NOT EXISTS generation INTEGER;

  CREATE INDEX IF NOT EXISTS idx_work_artifact_receipts_task_generation
    ON work_artifact_receipts (task_id, generation)
    WHERE generation IS NOT NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_work_artifact_receipts_task_generation;
  ALTER TABLE work_artifact_receipts DROP COLUMN IF EXISTS generation;
`;
