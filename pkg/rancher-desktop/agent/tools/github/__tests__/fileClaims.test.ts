import { describe, expect, it } from '@jest/globals';

import type { WorkFileClaimRecord } from '../../../database/models/WorkFileClaimModel';
import { formatClaimWarnings, globMatches, normalizeClaimGlob } from '../fileClaims';

const claim = (overrides: Partial<WorkFileClaimRecord> = {}): WorkFileClaimRecord => ({
  id:            'claim-1',
  repo_root:     '/repo',
  path_glob:     'pkg/**/*.ts',
  owner_job_id:  'job-2',
  owner_label:   'worker-2',
  worktree_path: '/worktrees/worker-2',
  created_at:    '2026-10-10T00:00:00Z',
  released_at:   null,
  ...overrides,
});

describe('file claim matching', () => {
  it('supports repository-relative glob stars', () => {
    expect(globMatches('pkg/tool.ts', 'pkg/**/*.ts')).toBe(true);
    expect(globMatches('pkg/deep/tool.ts', 'pkg/**/*.ts')).toBe(true);
    expect(globMatches('docs/tool.ts', 'pkg/**/*.ts')).toBe(false);
  });

  it('rejects absolute and escaping claim paths', () => {
    expect(() => normalizeClaimGlob('/etc/passwd')).toThrow();
    expect(() => normalizeClaimGlob('../other-repo/**')).toThrow();
  });

  it('warns for claims from another worktree', () => {
    const warning = formatClaimWarnings(['pkg/deep/tool.ts'], [claim()], '/worktrees/worker-1');
    expect(warning).toContain('WARNING');
    expect(warning).toContain('worker-2');
    expect(warning).toContain('pkg/deep/tool.ts');
  });

  it('does not warn the worktree that owns the claim', () => {
    expect(formatClaimWarnings(['pkg/deep/tool.ts'], [claim()], '/worktrees/worker-2')).toBe('');
  });
});
