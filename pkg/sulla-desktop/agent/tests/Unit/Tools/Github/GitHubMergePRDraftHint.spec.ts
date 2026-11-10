// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubMergePRWorker } from '../../../../tools/github/github_merge_pr';
import { createGitHubOctokit } from '../../../../tools/github/octokit';

vi.mock('../../../../tools/github/octokit', () => ({
  createGitHubOctokit: vi.fn(),
}));

const READY_COMMAND = `sulla github/ready_pr '{"owner":"acme","repo":"sulla","pull_number":42}'`;

function mockMerge(merge: ReturnType<typeof vi.fn>): void {
  vi.mocked(createGitHubOctokit).mockResolvedValue({ pulls: { merge } } as any);
}

async function mergeInput(): Promise<any> {
  return { owner: 'acme', repo: 'sulla', pull_number: 42, confirm: true };
}

describe('github merge_pr draft refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tells the agent to run ready_pr when GitHub throws a draft refusal', async() => {
    // risk: operability — a draft PR must be un-drafted with ready_pr, not closed and reopened.
    mockMerge(vi.fn().mockRejectedValue(Object.assign(new Error('Method Not Allowed'), {
      response: { data: { message: 'Pull Request is still a draft' } },
    })));
    const response = await (new GitHubMergePRWorker() as any)._validatedCall(await mergeInput());
    expect(response.successBoolean).toBe(false);
    expect(response.responseString).toContain('PR is a draft');
    expect(response.responseString).toContain(READY_COMMAND);
  });

  it('tells the agent to run ready_pr when GitHub returns merged:false for a draft', async() => {
    // risk: operability — same hint on the non-throwing refusal path.
    mockMerge(vi.fn().mockResolvedValue({ data: { merged: false, message: 'Draft pull requests are not mergeable' } }));
    const response = await (new GitHubMergePRWorker() as any)._validatedCall(await mergeInput());
    expect(response.successBoolean).toBe(false);
    expect(response.responseString).toContain(READY_COMMAND);
  });

  it('does not suggest ready_pr for an unrelated refusal', async() => {
    // risk: correctness — a failed required check must not be answered with an un-draft instruction.
    mockMerge(vi.fn().mockRejectedValue(Object.assign(new Error('Required status check is expected'), {
      response: { data: { message: 'Required status check "build" is expected.' } },
    })));
    const response = await (new GitHubMergePRWorker() as any)._validatedCall(await mergeInput());
    expect(response.successBoolean).toBe(false);
    expect(response.responseString).not.toContain('ready_pr');
  });
});
