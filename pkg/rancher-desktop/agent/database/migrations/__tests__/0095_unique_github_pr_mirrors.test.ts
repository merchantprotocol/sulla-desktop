import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0095_unique_github_pr_mirrors';

describe('0095_unique_github_pr_mirrors', () => {
  it('enforces stable identity only for active opt-in mirror tasks', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS github_pr_project_mirrors');
    expect(up).toContain('UNIQUE (provider, owner, repository, pull_number)');
    expect(up).toContain('snapshot_fingerprint TEXT');
    expect(up).toContain('sync_generation INTEGER');
    expect(up).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_work_tasks_github_pr_mirror_identity');
    expect(up).toContain('ON work_tasks (source_ref)');
    expect(up).toContain("source = 'github-pr-mirror'");
    expect(up).toContain("source_ref LIKE 'github-pr:%'");
    expect(up).toContain('archived = false');
    expect(down).toContain('DROP INDEX IF EXISTS uq_work_tasks_github_pr_mirror_identity');
    expect(down).toContain('DROP TABLE IF EXISTS github_pr_project_mirrors');
  });
});
