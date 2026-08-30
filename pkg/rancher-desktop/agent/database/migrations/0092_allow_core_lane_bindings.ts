/** Protected core bindings may target one exact stable lane or a semantic role. */
export const up = `
  ALTER TABLE work_lane_workflow_bindings
    DROP CONSTRAINT IF EXISTS work_lane_workflow_binding_scope_check;
  ALTER TABLE work_lane_workflow_bindings
    ADD CONSTRAINT work_lane_workflow_binding_scope_check CHECK (
      (scope = 'epic' AND epic_id IS NOT NULL AND project_id IS NULL AND lane_key IS NOT NULL)
      OR (scope = 'project' AND epic_id IS NULL AND project_id IS NOT NULL AND lane_key IS NOT NULL)
      OR (scope = 'global' AND epic_id IS NULL AND project_id IS NULL AND (lane_key IS NOT NULL OR semantic_role IS NOT NULL))
      OR (scope = 'core' AND epic_id IS NULL AND project_id IS NULL AND (lane_key IS NOT NULL OR semantic_role IS NOT NULL))
    );
`;

export const down = `
  DELETE FROM work_lane_workflow_bindings WHERE scope = 'core' AND semantic_role IS NULL;
  ALTER TABLE work_lane_workflow_bindings
    DROP CONSTRAINT IF EXISTS work_lane_workflow_binding_scope_check;
  ALTER TABLE work_lane_workflow_bindings
    ADD CONSTRAINT work_lane_workflow_binding_scope_check CHECK (
      (scope = 'epic' AND epic_id IS NOT NULL AND project_id IS NULL AND lane_key IS NOT NULL)
      OR (scope = 'project' AND epic_id IS NULL AND project_id IS NOT NULL AND lane_key IS NOT NULL)
      OR (scope = 'global' AND epic_id IS NULL AND project_id IS NULL AND (lane_key IS NOT NULL OR semantic_role IS NOT NULL))
      OR (scope = 'core' AND epic_id IS NULL AND project_id IS NULL AND semantic_role IS NOT NULL)
    );
`;
