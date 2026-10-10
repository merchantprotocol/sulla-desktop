import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0107_create_work_file_claims';

describe('0107_create_work_file_claims', () => {
  it('creates repository-scoped, releasable file claims', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS work_file_claims');
    expect(up).toContain('repo_root     TEXT NOT NULL');
    expect(up).toContain('path_glob     TEXT NOT NULL');
    expect(up).toContain('owner_job_id  TEXT');
    expect(up).toContain('released_at   TIMESTAMPTZ');
    expect(up).toContain('WHERE released_at IS NULL');
    expect(down).toContain('DROP TABLE IF EXISTS work_file_claims');
  });
});
