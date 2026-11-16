// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

import { Wsl2DockerRuntime } from './Wsl2DockerRuntime';
import type { Wsl2DockerRuntimeOptions, Wsl2RuntimeHost } from './Wsl2DockerRuntime';
import type { WslCommandResult } from './wsl2Host';

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    if (signal === 'SIGKILL') this.signalCode = signal;

    return true;
  });
}

/**
 * Parses argv the way GNU coreutils `env` does: options are recognised only
 * before the first NAME=VALUE (getopt '+' mode), `--` ends options, then
 * NAME=VALUE pairs are read until the first word without '='; that word is
 * the command. Asserting on this result checks meaning, not argv order.
 */
function parseGnuEnv(argv: string[]): { options: string[]; env: Record<string, string>; command?: string; args: string[] } {
  const parsed = { options: [] as string[], env: {} as Record<string, string>, command: undefined as string | undefined, args: [] as string[] };
  let index = 0;

  while (index < argv.length && argv[index].startsWith('-') && argv[index] !== '-') {
    if (argv[index] === '--') {
      index += 1;
      break;
    }
    parsed.options.push(argv[index]);
    index += 1;
  }
  while (index < argv.length && argv[index].includes('=')) {
    const separator = argv[index].indexOf('=');

    parsed.env[argv[index].slice(0, separator)] = argv[index].slice(separator + 1);
    index += 1;
  }
  parsed.command = argv[index];
  parsed.args = argv.slice(index + 1);

  return parsed;
}

const options: Wsl2DockerRuntimeOptions = {
  daemonCommand: '/usr/bin/dockerd-rootless.sh',
  daemonArgs: ['--host=unix:///run/user/1000/docker.sock'],
  readinessCommand: '/usr/bin/docker',
  readinessArgs: ['--host=unix:///run/user/1000/docker.sock', 'info'],
  environment: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock', XDG_RUNTIME_DIR: '/run/user/1000' },
  user: 'sulla',
  pollIntervalMs: 1,
  stopTimeoutMs: 1,
};

describe('Wsl2DockerRuntime', () => {
  it('starts the daemon as the unprivileged distro user and waits for Docker API readiness', async() => {
    const child = new FakeProcess();
    const runInDistribution = vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockRejectedValueOnce(new Error('daemon starting')).mockResolvedValue({ stdout: 'ready' });
    const host: Wsl2RuntimeHost = {
      runInDistribution,
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await runtime.start();
    await expect(runtime.run('/usr/bin/docker', ['ps', '--format', '{{.ID}}'])).resolves.toEqual({ stdout: 'ready' });
    expect(runtime.running).toBe(true);
    expect(host.spawnInDistribution).toHaveBeenCalledWith('/usr/bin/env', [
      '--', 'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', options.daemonCommand, ...options.daemonArgs,
    ], { windowsHide: true }, 'sulla');
    expect(runInDistribution).toHaveBeenNthCalledWith(1, '/usr/bin/env', [
      '--', 'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', '/usr/bin/id', '-u',
    ], 'sulla', expect.any(AbortSignal));
    expect(runInDistribution).toHaveBeenNthCalledWith(2, '/usr/bin/env', [
      '--', 'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', options.readinessCommand, ...options.readinessArgs,
    ], 'sulla', expect.any(AbortSignal));
    expect(runInDistribution).toHaveBeenNthCalledWith(3, '/usr/bin/env', [
      '--', 'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', options.readinessCommand, ...options.readinessArgs,
    ], 'sulla', expect.any(AbortSignal));
    expect(runInDistribution).toHaveBeenNthCalledWith(4, '/usr/bin/env', [
      '--', 'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', '/usr/bin/docker', 'ps', '--format', '{{.ID}}',
    ], 'sulla');
  });

  it('refuses runtime commands before start and kills the app-owned process when the readiness deadline passes', async() => {
    vi.useFakeTimers();
    try {
      const child = new FakeProcess();
      const host: Wsl2RuntimeHost = {
        runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockRejectedValue(new Error('not ready')),
        spawnInDistribution: vi.fn(() => child as any),
        terminateDistribution: vi.fn().mockResolvedValue(undefined),
      };
      // Deterministic clock: each poll sleep advances fake time instead of racing real time.
      const runtime = new Wsl2DockerRuntime(host, { ...options, readyTimeoutMs: 10, pollIntervalMs: 5 }, async ms => { vi.advanceTimersByTime(ms); });

      await expect(runtime.run('docker', ['ps'])).rejects.toThrow('not running');
      const started = expect(runtime.start()).rejects.toThrow(/Rootless Docker did not become ready within 10ms/);

      await vi.advanceTimersByTimeAsync(0);
      await vi.runAllTimersAsync();
      await started;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(host.terminateDistribution).toHaveBeenCalledTimes(1);
      expect(runtime.running).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an early daemon exit and does not mistake it for an available runtime', async() => {
    const child = new FakeProcess();
    child.exitCode = 17;
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValue({ stdout: '1000' }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await expect(runtime.start()).rejects.toThrow(/exited before becoming ready.*code 17/);
    expect(host.terminateDistribution).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(false);
  });

  it('refuses a missing or root runtime user before starting the daemon', async() => {
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValue({ stdout: '0\n' }),
      spawnInDistribution: vi.fn(() => new FakeProcess() as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options);

    await expect(runtime.start()).rejects.toThrow(/must exist and have a non-root numeric UID/);
    expect(host.spawnInDistribution).not.toHaveBeenCalled();

    const missingUserHost: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockRejectedValue(new Error('WSL user does not exist')),
      spawnInDistribution: vi.fn(() => new FakeProcess() as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const missingUserRuntime = new Wsl2DockerRuntime(missingUserHost, options);

    await expect(missingUserRuntime.start()).rejects.toThrow('WSL user does not exist');
    expect(missingUserHost.spawnInDistribution).not.toHaveBeenCalled();
  });

  it('rejects when a readiness probe hangs past the startup deadline and aborts that probe', async() => {
    const child = new FakeProcess();
    let probeSignal: AbortSignal | undefined;
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn((_command: string, _args: string[], _user?: string, signal?: AbortSignal) => {
        probeSignal = signal;
        if (_args.includes('/usr/bin/id')) return Promise.resolve({ stdout: '1000' });

        return new Promise<WslCommandResult>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true }));
      }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    vi.useFakeTimers();
    try {
      // Fake clock: the probe deadline and the forced-stop timer fire only when advanced.
      const runtime = new Wsl2DockerRuntime(host, { ...options, readyTimeoutMs: 5, stopTimeoutMs: 1 });
      const started = expect(runtime.start()).rejects.toThrow(/readiness probe timed out/);

      await vi.runAllTimersAsync();
      await started;
      expect(probeSignal?.aborted).toBe(true);
      expect(host.terminateDistribution).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-checks that the daemon process is alive after a successful readiness probe', async() => {
    const child = new FakeProcess();
    let probeCount = 0;
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockImplementation(async() => {
        probeCount += 1;
        if (probeCount === 1) return { stdout: '1000' };
        child.exitCode = 9;

        return { stdout: 'ready' };
      }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await expect(runtime.start()).rejects.toThrow(/exited while the readiness probe completed.*code 9/);
    expect(runtime.running).toBe(false);
    expect(host.terminateDistribution).toHaveBeenCalledTimes(1);
  });

  it('rejects shell-shaped environment entries before starting a process', async() => {
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: '' }),
      spawnInDistribution: vi.fn(() => new FakeProcess() as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, { ...options, environment: { 'DOCKER_HOST;id': '/tmp/socket' } }, async() => undefined);

    await expect(runtime.start()).rejects.toThrow(/Invalid WSL runtime environment entry/);
    expect(host.spawnInDistribution).not.toHaveBeenCalled();
  });

  it('rejects environment values containing line breaks before starting a process', async() => {
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: '' }),
      spawnInDistribution: vi.fn(() => new FakeProcess() as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, { ...options, environment: { DOCKER_HOST: 'unix:///tmp/socket\nDOCKER_HOST=evil' } }, async() => undefined);

    await expect(runtime.start()).rejects.toThrow(/Invalid WSL runtime environment entry/);
    expect(host.spawnInDistribution).not.toHaveBeenCalled();
  });

  it('terminates only the configured Sulla distro when stopping', async() => {
    const child = new FakeProcess();
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: '' }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await runtime.start();
    await runtime.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(host.terminateDistribution).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(false);
  });

  it('cancels the forced-stop timer when SIGTERM exits the child', async() => {
    const child = new FakeProcess();
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      }

      return true;
    });
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: '' }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    vi.useFakeTimers();
    try {
      const runtime = new Wsl2DockerRuntime(host, { ...options, stopTimeoutMs: 20 }, async() => undefined);

      await runtime.start();
      await runtime.stop();
      // A clean SIGTERM exit must clear the forced-stop timer, not leave it pending.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(40);

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds env argv that GNU env executes as the intended command with the intended environment', async() => {
    // risk: an env argv with a misplaced '--' runs '--' as the command (exit 127) and the daemon never starts.
    const child = new FakeProcess();
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: 'ready' }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await runtime.start();
    await runtime.run('/usr/bin/docker', ['ps', 'FILTER=a=b']);

    const [spawnCommand, spawnArgv] = (host.spawnInDistribution as any).mock.calls[0];
    const daemon = parseGnuEnv(spawnArgv);

    expect(spawnCommand).toBe('/usr/bin/env');
    expect(daemon).toEqual({ options: [], env: options.environment, command: options.daemonCommand, args: options.daemonArgs });

    const calls = (host.runInDistribution as any).mock.calls as [string, string[]][];

    expect(calls.map(([command]) => command)).toEqual(['/usr/bin/env', '/usr/bin/env', '/usr/bin/env']);
    expect(parseGnuEnv(calls[0][1])).toEqual({ options: [], env: options.environment, command: '/usr/bin/id', args: ['-u'] });
    expect(parseGnuEnv(calls[1][1])).toEqual({ options: [], env: options.environment, command: options.readinessCommand, args: options.readinessArgs });
    expect(parseGnuEnv(calls[2][1])).toEqual({ options: [], env: options.environment, command: '/usr/bin/docker', args: ['ps', 'FILTER=a=b'] });
  });

  it('refuses relative or assignment-shaped commands that env could misread', async() => {
    // risk: a relative or NAME=VALUE-shaped command would be parsed by env as an assignment or resolved via PATH.
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: 'ready' }),
      spawnInDistribution: vi.fn(() => new FakeProcess() as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await runtime.start();
    await expect(runtime.run('docker', ['ps'])).rejects.toThrow(/Invalid WSL runtime command/);
    await expect(runtime.run('/usr/bin/FOO=bar', [])).rejects.toThrow(/Invalid WSL runtime command/);
    expect(host.runInDistribution).toHaveBeenCalledTimes(2);

    const badDaemonHost: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValue({ stdout: '1000' }),
      spawnInDistribution: vi.fn(() => new FakeProcess() as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const badDaemon = new Wsl2DockerRuntime(badDaemonHost, { ...options, daemonCommand: 'dockerd-rootless.sh' }, async() => undefined);

    await expect(badDaemon.start()).rejects.toThrow(/Invalid WSL runtime command/);
    expect(badDaemonHost.spawnInDistribution).not.toHaveBeenCalled();
  });

  it('keeps one error listener on the daemon while it runs and removes it on stop', async() => {
    // risk: a late child 'error' with no listener throws and crashes the Electron main process; a leaked listener pins the old child.
    const child = new FakeProcess();
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: 'ready' }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await runtime.start();
    expect(child.listenerCount('error')).toBe(1);
    expect(() => child.emit('error', new Error('late failure one'))).not.toThrow();
    expect(() => child.emit('error', new Error('late failure two'))).not.toThrow();
    expect(child.listenerCount('error')).toBe(1);

    await runtime.stop();
    expect(child.listenerCount('error')).toBe(0);
  });

  it('shares one in-flight start between concurrent callers and spawns a single daemon', async() => {
    // risk: two concurrent starts would spawn two daemons in one distro and orphan one of them.
    const child = new FakeProcess();
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: 'ready' }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    const first = runtime.start();
    const second = runtime.start();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(host.spawnInDistribution).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(true);

    // After it settles, a fresh start on a running runtime is a no-op rather than a second spawn.
    await runtime.start();
    expect(host.spawnInDistribution).toHaveBeenCalledTimes(1);
  });

  it('lets a new start run after a failed in-flight start settles', async() => {
    // risk: a stuck in-flight promise would make every later start return the old failure.
    const child = new FakeProcess();
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValueOnce({ stdout: '0' }).mockResolvedValueOnce({ stdout: '1000' }).mockResolvedValue({ stdout: 'ready' }),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await expect(runtime.start()).rejects.toThrow(/non-root numeric UID/);
    await runtime.start();
    expect(runtime.running).toBe(true);
    expect(host.spawnInDistribution).toHaveBeenCalledTimes(1);
  });
});
