// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitPushWorker } from '../../../../tools/github/git_push';
import { runCommand } from '../../../../tools/util/CommandRunner';

vi.mock('../../../../tools/util/CommandRunner', () => ({ runCommand: vi.fn() }));
vi.mock('../../../../../vault-broker', () => ({ usesContainerVaultAuthority: () => false }));
const { getIntegrationValue } = vi.hoisted(() => ({ getIntegrationValue: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../../services/IntegrationService', () => ({ getIntegrationService: () => ({ getIntegrationValue }) }));

const localHead = 'a'.repeat(40);
const checkedOutHead = 'c'.repeat(40);
const mockCommands = (remoteHead: string, pushExitCode = 0) => (runCommand as any).mockImplementation(async(command: string) => {
  if (command.includes('rev-parse --show-toplevel')) return { stdout: '/repo', stderr: '', exitCode: 0 };
  if (command.includes('rev-parse --abbrev-ref')) return { stdout: 'main', stderr: '', exitCode: 0 };
  if (command.includes('remote get-url')) return { stdout: 'https://github.com/org/repo.git', stderr: '', exitCode: 0 };
  if (command.includes('rev-parse --verify')) return { stdout: `${ command.includes('refs/heads/feature') ? localHead : checkedOutHead }\n`, stderr: '', exitCode: 0 };
  if (command.includes('ls-remote')) return { stdout: remoteHead ? `${ remoteHead }\trefs/heads/${ command.match(/refs\/heads\/([^\s]+)/)?.[1] || 'main' }\n` : '', stderr: '', exitCode: 0 };
  if (command.includes(' push ')) return { stdout: '', stderr: pushExitCode ? 'transport failed' : '', exitCode: pushExitCode };
  return { stdout: '', stderr: `unexpected command: ${ command }`, exitCode: 1 };
});

describe('GitPushWorker remote verification', () => {
  beforeEach(() => { vi.clearAllMocks(); getIntegrationValue.mockResolvedValue(undefined); });

  it('accepts a push only when the remote branch matches local HEAD', async() => {
    // risk: data loss — a reported push must correspond to the exact local commit on the remote ref.
    mockCommands(localHead);
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo' });
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('Pushed to origin/main');
    expect(runCommand).toHaveBeenCalledWith(expect.stringContaining('ls-remote'), [], expect.any(Object));
  });

  it('verifies the tip of an explicitly pushed branch rather than checked-out HEAD', async() => {
    // risk: data integrity — success must describe the exact non-checked-out branch tip that was pushed.
    mockCommands(localHead);
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo', branch: 'feature' });
    expect(result.successBoolean).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(expect.stringContaining('rev-parse --verify "refs/heads/feature^{commit}"'), [], expect.any(Object));
  });

  it('fails when an explicitly pushed branch tip differs from its remote ref', async() => {
    // risk: data integrity — a stale remote must not be reported as a successful branch push.
    mockCommands('b'.repeat(40));
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo', branch: 'feature' });
    expect(result.successBoolean).toBe(false);
  });

  it('authenticates private-remote verification and redacts the token', async() => {
    // risk: availability and credential confidentiality — private verification must work without exposing the PAT.
    const token = 'test-private-token';
    getIntegrationValue.mockResolvedValue({ value: token });
    mockCommands(localHead);
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo' });
    expect(result.successBoolean).toBe(true);
    const verification = (runCommand as any).mock.calls.find(([command]: [string]) => command.includes('ls-remote'))[0];
    expect(verification).toContain(`GH_PAT='${ token }'`);
    expect(result.responseString).not.toContain(token);
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

  it.each(['a;b', '$(id)', '`id`', 'a b', '-f', 'a..b'])(
    'rejects unsafe branch name %s before invoking git', async(branch) => {
      // risk: command injection — caller-controlled branch names must never reach shell command construction.
      const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo', branch });
      expect(result).toEqual({ successBoolean: false, responseString: 'Git push failed: invalid branch/remote name' });
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it('rejects unsafe remote names before invoking git', async() => {
    // risk: command injection — caller-controlled remote names must not reach git command arguments.
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo', remote: 'origin;id' });
    expect(result).toEqual({ successBoolean: false, responseString: 'Git push failed: invalid branch/remote name' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects an unsafe current branch before constructing push commands', async() => {
    // risk: command injection — repository-derived branch names must pass the same shell-safety boundary.
    (runCommand as any).mockImplementation(async(command: string) => command.includes('rev-parse --abbrev-ref')
      ? { stdout: 'bad;name', stderr: '', exitCode: 0 }
      : { stdout: '/repo', stderr: '', exitCode: 0 });
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo' });
    expect(result).toEqual({ successBoolean: false, responseString: 'Git push failed: invalid branch/remote name' });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it.each(['fix/f6-reliability-port', 'feature/a_b.c', 'main'])(
    'continues to push valid branch name %s', async(branch) => {
      // risk: availability — safe, conventional branch names must retain push behavior.
      mockCommands(localHead);
      const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/repo', branch });
      expect(result.successBoolean).toBe(true);
      // risk: command injection — validated names are still passed to the shell as quoted arguments.
      expect(runCommand).toHaveBeenCalledWith(expect.stringContaining(`push "origin" "${ branch }"`), [], expect.any(Object));
      expect(runCommand).toHaveBeenCalledWith(expect.stringContaining(`ls-remote "origin" "refs/heads/${ branch }"`), [], expect.any(Object));
    },
  );
});
