// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { GuestCommandError, GuestCommandRunner, type GuestExecFile } from '../../../services/GuestCommandRunner';
import { GuestDiskFullError } from '../../../services/GuestDiskFullError';

interface Outcome { code?: number | null; signal?: string; stdout?: string; stderr?: string }

const MKDIR = ['sh', '-c', 'set -eu; mktemp -d "$1/container-XXXXXXXX"', 'sulla-guest-mkdir', '/mnt/data/sulla/runtime/provider-transport'];
const CREATED = '/mnt/data/sulla/runtime/provider-transport/container-CUK4RNyF';

/** Plays one scripted `sulla-runtime exec` outcome per call, like child_process.execFile. */
function scriptedExec(outcomes: Outcome[]) {
  const calls: string[][] = [];
  const execFile = vi.fn(((_file, args, _options, callback) => {
    calls.push(args);
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    const failed = outcome.code !== undefined && outcome.code !== 0;
    const error = failed || outcome.signal
      ? Object.assign(new Error('Command failed'), { code: outcome.code ?? null, signal: outcome.signal ?? null })
      : null;
    queueMicrotask(() => callback(error as any, outcome.stdout ?? '', outcome.stderr ?? ''));
    return { stdin: { on: vi.fn(), end: vi.fn() } } as any;
  }) as GuestExecFile);
  return { execFile, calls };
}

function runner(execFile: GuestExecFile, attempts?: number) {
  const sleep = vi.fn(async() => {});
  const instance = new GuestCommandRunner({
    runtimeBinary: () => '/Applications/Sulla.app/sulla-runtime',
    execFile,
    environment:   () => ({}),
    redact:        text => text.trim(),
    sleep,
    attempts,
  });
  return { instance, sleep };
}

describe('GuestCommandRunner: lost guest exec channel', () => {
  it('retries a transport 255 once and returns the second result instead of failing the worker', async() => {
    // risk: a worker killed 2.4 s in by "Error: /mnt/.../container-XXXX" (job agent-job-1794841591558-186)
    const { execFile, calls } = scriptedExec([
      { code: 255, stdout: CREATED, stderr: '' },
      { code: 0, stdout: `${ CREATED }-retry\n` },
    ]);
    const { instance, sleep } = runner(execFile);

    await expect(instance.run(MKDIR, undefined, 30_000)).resolves.toBe(`${ CREATED }-retry`);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['exec', '--', ...MKDIR]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries when the runtime itself reports the closed guest connection', async() => {
    // risk: "Guest command exited 255" killing a worker on a one-off vsock drop
    const { execFile, calls } = scriptedExec([
      { code: 255, stderr: 'sulla-runtime: guest connection closed\n' },
      { code: 0, stdout: 'ok' },
    ]);
    await expect(runner(execFile).instance.run(['docker', 'ps'], undefined, 30_000)).resolves.toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('fails with the exit code and step name, never the bare stdout path, when the retry also fails', async() => {
    // risk: an undiagnosable error message that drops the exit code
    const { execFile, calls } = scriptedExec([{ code: 255, stdout: CREATED, stderr: '' }]);
    const error = await runner(execFile).instance.run(MKDIR, undefined, 30_000).catch(e => e);

    expect(calls).toHaveLength(2);
    expect(error).toBeInstanceOf(GuestCommandError);
    expect(error.exitCode).toBe(255);
    expect(error.message).toBe('Guest command sulla-guest-mkdir exited 255 with no stderr');
    expect(error.message).not.toBe(CREATED);
  });
});

describe('GuestCommandRunner: real command failures', () => {
  it('does not retry a command that failed on its own, and keeps its stderr and exit code', async() => {
    // risk: re-running a non-transport failure and hiding the real cause
    const { execFile, calls } = scriptedExec([{ code: 73, stdout: '', stderr: 'realpath: /mnt/x: No such file or directory' }]);
    const error = await runner(execFile).instance.run(MKDIR, undefined, 30_000).catch(e => e);

    expect(calls).toHaveLength(1);
    expect(error.exitCode).toBe(73);
    expect(error.message).toBe('Guest command sulla-guest-mkdir exited 73: realpath: /mnt/x: No such file or directory');
  });

  it('does not retry a 255 that carries the command\'s own stderr', async() => {
    // risk: replaying a non-idempotent command that really exited 255
    const { execFile, calls } = scriptedExec([{ code: 255, stderr: 'docker: conflict: name already in use' }]);
    await expect(runner(execFile).instance.run(['docker', 'create'], undefined, 30_000)).rejects.toThrow('exited 255: docker: conflict');
    expect(calls).toHaveLength(1);
  });

  it('still turns a full guest disk into the single non-retryable disk-full failure', async() => {
    // risk: a full VM disk retried and blamed on a provider
    const { execFile, calls } = scriptedExec([{ code: 2, stderr: 'can\'t create /mnt/data/x: No space left on device' }]);
    const error = await runner(execFile).instance.run(MKDIR, undefined, 30_000).catch(e => e);
    expect(error).toBeInstanceOf(GuestDiskFullError);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a command killed by its own timeout', async() => {
    // risk: doubling a 30 s hang into 60 s
    const { execFile, calls } = scriptedExec([{ code: null, signal: 'SIGKILL' }]);
    await expect(runner(execFile).instance.run(MKDIR, undefined, 30_000)).rejects.toThrow('Command failed');
    expect(calls).toHaveLength(1);
  });
});
