import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0067_add_review_disposition_evidence';

describe('0067_add_review_disposition_evidence', () => {
  it('adds generation-bound review evidence without replacing the live lease guard', () => {
    expect(up).toContain('origin_dispatch_id');
    expect(up).toContain('reviewer_agent_ids');
    expect(up).toContain('review_artifact_hash');
    expect(up).toContain('review_generation_hash');
    expect(up).toContain('review_artifact_types');
    expect(up).toContain('review_artifacts');
    expect(up).toContain('excluded_agent_ids');
    expect(up).toContain('worker_agent_ids');
    expect(up).toContain('custodian_agent_ids');
    expect(up).toContain('findings_fingerprint');
    expect(up).toContain("'PASS', 'REPAIRABLE', 'REPLAN', 'EXTERNAL_WAIT', 'BLOCKED'");
    expect(up).not.toContain('DROP INDEX IF EXISTS idx_work_task_dispatches_one_live');
  });

  it('has a complete reversible down migration', () => {
    expect(down).toContain('DROP COLUMN IF EXISTS disposition');
    expect(down).toContain('DROP COLUMN IF EXISTS origin_dispatch_id');
  });
});
