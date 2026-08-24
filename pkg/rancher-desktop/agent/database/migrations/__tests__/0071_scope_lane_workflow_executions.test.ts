import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0071_scope_lane_workflow_executions';

describe('0071_scope_lane_workflow_executions', () => {
  it('adds paired task/generation scope and an active scoped uniqueness boundary', () => {
    expect(up).toContain('scope_task_id');
    expect(up).toContain('scope_generation');
    expect(up).toContain('workflow_executions_scope_pair_check');
    expect(up).toContain('idx_wf_executions_active_lane_scope');
    expect(up).toContain("status IN ('running', 'suspended')");
  });

  it('is reversible', () => {
    expect(down).toContain('DROP INDEX IF EXISTS idx_wf_executions_active_lane_scope');
    expect(down).toContain('DROP COLUMN IF EXISTS scope_generation');
    expect(down).toContain('DROP COLUMN IF EXISTS scope_task_id');
  });
});
