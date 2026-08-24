import { describe, expect, it } from '@jest/globals';

import { up } from '../0073_create_lifecycle_capabilities';

describe('0073_create_lifecycle_capabilities', () => {
  it('seeds all protected lifecycle capabilities and enforces one live stage owner', () => {
    for (const key of [
      'planning-council', 'todo-execution', 'in-review-verification',
      'durable-waits', 'stale-recovery',
    ]) {
      expect(up).toContain(`('${ key }'`);
    }
    expect(up).toContain('idx_work_task_stage_claims_one_live');
    expect(up).toContain("WHERE status = 'active'");
    expect(up).not.toContain('expires_at');
  });
});
