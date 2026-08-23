import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0069_create_work_lane_definitions';

describe('0069_create_work_lane_definitions', () => {
  it('is schema-only and leaves every existing task status untouched', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS work_lane_definitions');
    expect(up).toContain("scope IN ('global_default', 'project')");
    expect(up).not.toContain('BETWEEN 1 AND 120');
    expect(up).toContain('idx_work_lane_definitions_active_key');
    expect(up).toContain('WHERE reset_at IS NULL');
    expect(up).not.toMatch(/INSERT\s+INTO\s+work_lane_definitions/i);
    expect(up).not.toMatch(/UPDATE\s+work_tasks/i);
  });

  it('has a reversible table drop', () => {
    expect(down).toContain('DROP TABLE IF EXISTS work_lane_definitions');
  });
});
