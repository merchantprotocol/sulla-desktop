import { describe, expect, it } from '@jest/globals';
import { down, up } from '../0078_add_in_review_artifact_custody';

describe('0078_add_in_review_artifact_custody', () => {
  it('creates structured receipts and marks historical review rows legacy', () => {
    expect(up).toContain('work_task_artifact_custody');
    expect(up).toContain("custody_status IN ('validated', 'legacy')");
    expect(up).toContain("'legacy'");
    expect(up).toContain('ON CONFLICT (id) DO NOTHING');
  });
  it('is reversible', () => {
    expect(down).toContain('DROP TABLE IF EXISTS work_task_artifact_custody');
  });
});
