import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0070_create_lane_workflow_bindings';

describe('0070_create_lane_workflow_bindings', () => {
  it('enforces scoped bindings and one active binding per scope', () => {
    expect(up).toContain("scope IN ('epic', 'project', 'global', 'core')");
    expect(up).toContain('work_lane_workflow_binding_scope_check');
    expect(up).toContain('idx_work_lane_workflow_bindings_active_scope');
    expect(up).toContain('WHERE active = true AND archived = false');
  });

  it('uses task and generation as the lane-entry idempotency boundary', () => {
    expect(up).toContain('UNIQUE (task_id, generation)');
    expect(up).toContain('binding_snapshot');
    expect(up).toContain('workflow_snapshot');
    expect(up).toContain('fallback_reason');
  });

  it('is schema-only and reversible', () => {
    expect(up).not.toMatch(/INSERT\s+INTO/i);
    expect(up).not.toMatch(/UPDATE\s+work_tasks/i);
    expect(down).toContain('DROP TABLE IF EXISTS work_lane_entry_automations');
    expect(down).toContain('DROP TABLE IF EXISTS work_lane_workflow_bindings');
  });
});
