import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0092_allow_core_lane_bindings';

describe('0092_allow_core_lane_bindings', () => {
  it('lets protected core bindings target an exact lane without weakening other scopes', () => {
    expect(up).toContain("scope = 'core'");
    expect(up).toContain('(lane_key IS NOT NULL OR semantic_role IS NOT NULL)');
    expect(up).toContain("scope = 'epic' AND epic_id IS NOT NULL");
    expect(down).toContain("DELETE FROM work_lane_workflow_bindings WHERE scope = 'core' AND semantic_role IS NULL");
  });
});
