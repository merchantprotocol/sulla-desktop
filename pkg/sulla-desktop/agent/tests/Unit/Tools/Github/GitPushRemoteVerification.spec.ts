// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitPushWorker } from '../../../../tools/github/git_push';
import { runCommand } from '../../../../tools/util/CommandRunner';

vi.mock('../../../../tools/util/CommandRunner', () => ({ runCommand: vi.fn() }));
vi.mock('../../../../../vault-broker', () => ({ usesContainerVaultAuthority: () => false }));
vi.mock('../../../../services/IntegrationService', () => ({ getIntegrationService: () => ({ getIntegrationValue: vi.fn().mockResolvedValue(undefined) }) }));

const localHead = 'a'.repeat(40);
const mockCommands = (remoteHead: string, pushExitCode = 0) => (runCommand as any).mockImplementation(async(command: string) => {
  if (command.includes('rev-parse --show-toplevel')) return { stdout: '/repo', stderr: '', exitCode: 0 };
  if (command.includes('rev-parse --abbrev-ref')) return { stdout: 'main', stderr: '', exitCode: 0 };
  if (command.includes('remote get-url')) return { stdout: 'https://github.com/org/repo.git', stderr: '', exitCode: 0 };
  if (command.includes('rev-parse HEAD')) return { stdout: `${ localHead }\n`, stderr: '', exitCode: 0 };
  if (command.includes('ls-remote')) return { stdout: remoteHead ? `${ remoteHead }\trefs/heads/main\n` : '', stderr: '', exitCode: 0 };
  if (command.includes(' push ')) return { stdout: '', stderr: pushExitCode ? 'transport failed' : '', exitCode: pushExitCode };
  return { stdout: '', stderr: `unexpected command: ${ command }`, exitCode: 1 };
});

describe('GitPushWorker remote verification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a push only when the remote branch matches local HEAD', async() => {
    // risk: data loss — a reported push must correspond to the exact local commit on the remote ref.
    mockCommands(localHead);
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo' });
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('Pushed to origin/main');
    expect(runCommand).toHaveBeenCalledWith(expect.stringContaining('ls-remote'), [], expect.any(Object));
  });

  it('fails when the remote branch does not match local HEAD', async() => {
    // risk: data loss — callers must not trust a successful transport that left the remote stale.
    mockCommands('b'.repeat(40));
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo' });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('remote ref did not match local HEAD');
  });

  it('recognizes a transport error when the remote nevertheless accepted the commit', async() => {
    // risk: data loss — retrying an accepted push can create duplicate or unsafe follow-up actions.
    mockCommands(localHead, 1);
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo' });
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('reported an error');
  });
});
