// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

import { Wsl2DockerRuntime, Wsl2RuntimeHost } from './Wsl2DockerRuntime';

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

const options = {
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
    const runInDistribution = vi.fn().mockRejectedValueOnce(new Error('daemon starting')).mockResolvedValue({ stdout: 'ready' });
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
      'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', '--', options.daemonCommand, ...options.daemonArgs,
    ], { windowsHide: true }, 'sulla');
    expect(runInDistribution).toHaveBeenNthCalledWith(1, '/usr/bin/env', [
      'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', '--', options.readinessCommand, ...options.readinessArgs,
    ], 'sulla');
    expect(runInDistribution).toHaveBeenNthCalledWith(2, '/usr/bin/env', [
      'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', '--', options.readinessCommand, ...options.readinessArgs,
    ], 'sulla');
    expect(runInDistribution).toHaveBeenNthCalledWith(3, '/usr/bin/env', [
      'DOCKER_HOST=unix:///run/user/1000/docker.sock', 'XDG_RUNTIME_DIR=/run/user/1000', '--', '/usr/bin/docker', 'ps', '--format', '{{.ID}}',
    ], 'sulla');
  });

  it('refuses runtime commands before start and kills the app-owned process on readiness timeout', async() => {
    const child = new FakeProcess();
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockRejectedValue(new Error('not ready')),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, { ...options, readyTimeoutMs: 0 }, async() => undefined);

    await expect(runtime.run('docker', ['ps'])).rejects.toThrow('not running');
    await expect(runtime.start()).rejects.toThrow(/did not become ready/);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(host.terminateDistribution).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(false);
  });

  it('reports an early daemon exit and does not mistake it for an available runtime', async() => {
    const child = new FakeProcess();
    child.exitCode = 17;
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockRejectedValue(new Error('daemon stopped')),
      spawnInDistribution: vi.fn(() => child as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, options, async() => undefined);

    await expect(runtime.start()).rejects.toThrow(/exited before becoming ready.*code 17/);
    expect(host.terminateDistribution).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(false);
  });

  it('rejects shell-shaped environment entries before starting a process', async() => {
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValue({ stdout: '' }),
      spawnInDistribution: vi.fn(() => new FakeProcess() as any),
      terminateDistribution: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new Wsl2DockerRuntime(host, { ...options, environment: { 'DOCKER_HOST;id': '/tmp/socket' } }, async() => undefined);

    await expect(runtime.start()).rejects.toThrow(/Invalid WSL runtime environment entry/);
    expect(host.spawnInDistribution).not.toHaveBeenCalled();
  });

  it('terminates only the configured Sulla distro when stopping', async() => {
    const child = new FakeProcess();
    const host: Wsl2RuntimeHost = {
      runInDistribution: vi.fn().mockResolvedValue({ stdout: '' }),
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
});
