import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0064_add_verification_dispatches';

describe('0064_add_verification_dispatches', () => {
  it('adds auditable verification fields without weakening the one-live-lease index', () => {
    expect(up).toContain("kind TEXT NOT NULL DEFAULT 'execution'");
    expect(up).toContain('attempt INTEGER NOT NULL DEFAULT 1');
    expect(up).toContain('verdict TEXT');
    expect(up).toContain('artifact_sha TEXT');
    expect(up).toContain('failure_reason TEXT');
    expect(up).toContain("CHECK (kind IN ('execution', 'verification'))");
    expect(up).not.toContain('DROP INDEX IF EXISTS idx_work_task_dispatches_one_live');
  });

  it('has a reversible down migration', () => {
    expect(down).toContain('DROP COLUMN IF EXISTS artifact_sha');
    expect(down).toContain('DROP COLUMN IF EXISTS kind');
  });
});
