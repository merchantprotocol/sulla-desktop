import { describe, expect, it } from '@jest/globals';

import { resolveLimaHome, resolveLimactlPath, runCommand, shouldFallbackFromLimaShell } from '../CommandRunner';

describe('CommandRunner', () => {
  it('runs shell commands successfully (baseline PATH/shell access)', async() => {
    const result = await runCommand('sh', ['-c', 'echo hello'], {
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('returns ENOENT-style errors for missing binaries', async() => {
    const result = await runCommand('/definitely/missing/binary', [], {
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('Spawn error');
  });

  it('Lima shell mode fails gracefully when limactl cannot be resolved', async() => {
    const previousPath = process.env.PATH;
    process.env.PATH = '';

    try {
      const result = await runCommand('echo hello', [], {
        runInLimaShell: true,
        limaHome:       '/tmp/lima-home',
        limactlPath:    '/definitely/missing/limactl',
        timeoutMs:      5_000,
      });

      expect(result.exitCode).not.toBe(0);
      expect(`${ result.stderr }\n${ result.stdout }`).toMatch(/not found|no such file|spawn error|does not exist/i);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('detects limactl instance-missing output for local-shell fallback', () => {
    expect(shouldFallbackFromLimaShell({
      exitCode: 1,
      stderr:   'time="2026-02-19T19:19:33-08:00" level=fatal msg="instance "0" does not exist"',
      stdout:   '',
    })).toBe(true);

    expect(shouldFallbackFromLimaShell({
      exitCode: 127,
      stderr:   'Spawn error: spawn limactl ENOENT',
      stdout:   '',
    })).toBe(false);
  });

  it('prefers explicit LIMA_HOME and LIMACTL_PATH environment settings', () => {
    const previousLimaHome = process.env.LIMA_HOME;
    const previousLimactlPath = process.env.LIMACTL_PATH;
    process.env.LIMA_HOME = '/tmp/custom-lima-home';
    process.env.LIMACTL_PATH = '/tmp/custom-limactl';

    try {
      expect(resolveLimaHome({})).toBe('/tmp/custom-lima-home');
      expect(resolveLimactlPath({})).toBe('/tmp/custom-limactl');
    } finally {
      process.env.LIMA_HOME = previousLimaHome;
      process.env.LIMACTL_PATH = previousLimactlPath;
    }
  });
});
