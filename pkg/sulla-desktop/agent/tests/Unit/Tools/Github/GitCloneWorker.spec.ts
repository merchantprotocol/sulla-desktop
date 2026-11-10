// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitCloneWorker } from '../../../../tools/github/git_clone';
import { runCommand } from '../../../../tools/util/CommandRunner';
import { withGitHubBrokerRemote } from '../../../../tools/github/gitBrokerTransport';

vi.mock('../../../../tools/util/CommandRunner', () => ({ runCommand: vi.fn() }));
vi.mock('../../../../tools/github/gitBrokerTransport', () => ({ withGitHubBrokerRemote: vi.fn() }));
vi.mock('../../../../../vault-broker', () => ({ usesContainerVaultAuthority: () => true }));

describe('GitCloneWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clones through the broker and resets origin to token-free GitHub HTTPS', async() => {
    // risk: credential disclosure — broker-only URL must not persist in .git/config.
    vi.mocked(withGitHubBrokerRemote).mockImplementation(async(_context, _remote, run) => await run('http://127.0.0.1/one-use-secret/acme/repo.git') as any);
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any);
    const worker = new GitCloneWorker();
    worker.executionContext = { v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'user', org_id: 'org', agent_id: 'agent', job_id: 'job', pod_id: 'pod', device_id: 'device', scopes: ['*'], iat: 1, exp: 9999999999, jti: 'jti', request_id: 'request' };
    const result = await (worker as any)._validatedCall({ owner: 'acme', repo: 'repo', absolutePath: '/workspace/repo', branch: 'main', depth: 1 });
    expect(result.successBoolean).toBe(true);
    expect(withGitHubBrokerRemote).toHaveBeenCalledWith(worker.executionContext, 'https://github.com/acme/repo.git', expect.any(Function));
    expect(vi.mocked(runCommand).mock.calls[0][0]).toContain('one-use-secret');
    expect(vi.mocked(runCommand).mock.calls[1][0]).toContain('remote set-url origin');
    expect(vi.mocked(runCommand).mock.calls[1][0]).toContain('https://github.com/acme/repo.git');
    expect(vi.mocked(runCommand).mock.calls[1][0]).not.toContain('one-use-secret');
  });
});
