// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { GitHubDeleteRefWorker } from '../../../../tools/github/github_delete_ref';

const { getRef, deleteRef } = vi.hoisted(() => ({ getRef: vi.fn(), deleteRef: vi.fn() }));
vi.mock('../../../../tools/github/octokit', () => ({ createGitHubOctokit: async() => ({ git: { getRef, deleteRef } }) }));

describe('GitHubDeleteRefWorker', () => {
  it('reports success only after deleteRef resolves', async() => {
    // risk: data loss — deletion success must reflect the remote API result and retain its restore SHA.
    getRef.mockResolvedValue({ data: { object: { sha: 'abcdef1234567890' } } });
    deleteRef.mockResolvedValue({ status: 204 });
    const result = await (new GitHubDeleteRefWorker() as any)._validatedCall({ owner: 'org', repo: 'repo', branch: 'feature', confirm: true });
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('abcdef1234567890');
    expect(deleteRef).toHaveBeenCalledWith({ owner: 'org', repo: 'repo', ref: 'heads/feature' });
  });

  it('reports a remote deletion failure as failure', async() => {
    // risk: data loss — API rejection must never be presented as a completed deletion.
    getRef.mockResolvedValue({ data: { object: { sha: 'abcdef1' } } });
    deleteRef.mockRejectedValue(new Error('remote refused'));
    const result = await (new GitHubDeleteRefWorker() as any)._validatedCall({ owner: 'org', repo: 'repo', branch: 'feature', confirm: true });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('remote refused');
  });
});
