// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { DockerHostCommandResult, dockerSocketPathFromEndpoint, LinuxDockerHost, prepareLinuxRuntimePaths } from './dockerHost';

function result(stdout = '', exitCode = 0): DockerHostCommandResult {
  return { stdout, stderr: '', exitCode };
}

function rootlessDocker(): (args: string[]) => Promise<DockerHostCommandResult> {
  return vi.fn(async(args: string[]) => {
    if (args[0] === 'compose') return result('2.30.0');
    if (args[0] === 'context') return result('unix:///run/user/1000/docker.sock');
    if (args[0] === 'info') return result('["name=seccomp,profile=builtin","name=rootless"]');

    return result();
  });
}

describe('LinuxDockerHost', () => {
  it('accepts only a reachable local rootless Engine with recent Compose v2', async() => {
    const inspect = await new LinuxDockerHost(rootlessDocker()).inspect();

    expect(inspect).toMatchObject({
      cliAvailable: true, composeVersion: '2.30.0', engineAvailable: true, rootless: true,
      socketPath: '/run/user/1000/docker.sock',
    });
    expect(inspect.errors).toEqual([]);
  });

  it('rejects rootful Docker rather than exposing the host-root socket to services', async() => {
    const runner = rootlessDocker();
    runner.mockImplementation(async(args: string[]) => args[0] === 'info'
      ? result('["name=seccomp,profile=builtin"]')
      : args[0] === 'context' ? result('unix:///var/run/docker.sock') : result('2.30.0'));

    const inspection = await new LinuxDockerHost(runner).inspect();

    expect(inspection.rootless).toBe(false);
    expect(inspection.errors).toContain('A rootless Docker Engine is required to protect the Linux host.');
    await expect(new LinuxDockerHost(runner).assertReady()).rejects.toThrow(/rootless Docker Engine/);
  });

  it('rejects TCP contexts and old Compose', async() => {
    const runner = vi.fn(async(args: string[]) => args[0] === 'compose'
      ? result('2.16.0')
      : args[0] === 'context' ? result('tcp://docker.example:2376') : result());
    const inspection = await new LinuxDockerHost(runner).inspect();

    expect(inspection.engineAvailable).toBe(false);
    expect(inspection.errors).toContain('Docker Compose v2.17.0 or newer is required.');
    expect(inspection.errors).toContain('A local Unix-socket Docker Engine is required; remote Docker contexts are not supported.');
  });

  it('extracts local Unix socket paths and rejects non-Unix endpoints', () => {
    expect(dockerSocketPathFromEndpoint('unix:///run/user/1000/docker%20sock')).toBe('/run/user/1000/docker sock');
    expect(() => dockerSocketPathFromEndpoint('tcp://localhost:2376')).toThrow(/Unix socket/);
  });

  it('starts and stops only its app-named compose project, never removes volumes or stops the daemon', async() => {
    const composeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-compose-')), 'compose.yaml');
    fs.writeFileSync(composeFile, 'services: {}\n');
    const runner = rootlessDocker();
    const host = new LinuxDockerHost(runner);
    const project = { composeFile, projectName: 'sulla-desktop-test' };
    const calls: string[][] = [];
    runner.mockImplementation(async(args: string[]) => {
      calls.push(args);
      if (args[0] === 'compose' && args[1] === 'version') return result('2.30.0');
      if (args[0] === 'context') return result('unix:///run/user/1000/docker.sock');
      if (args[0] === 'info') return result('["name=rootless"]');
      return result();
    });

    try {
      await host.startProject(project);
      await host.stopProject(project);
    } finally {
      fs.rmSync(path.dirname(composeFile), { recursive: true, force: true });
    }

    expect(calls.find(args => args.includes('up'))).toEqual(expect.arrayContaining(['--wait', '--wait-timeout', '300']));
    const down = calls.find(args => args.includes('down'))!;
    expect(down).toContain('--remove-orphans');
    expect(down).not.toContain('--volumes');
    expect(calls.some(args => args[0] === 'stop' || args[0] === 'kill')).toBe(false);
  });

  it('rejects caller-provided project names that could target another compose namespace', async() => {
    const host = new LinuxDockerHost(rootlessDocker());
    await expect(host.startProject({ composeFile: '/not-read', projectName: 'other project' })).rejects.toThrow(/project name/);
  });

  it('creates private app-owned runtime paths and rejects symlinked path components', async() => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-user-data-'));
    const paths = await prepareLinuxRuntimePaths(appData);
    expect(fs.statSync(paths.root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.secrets).mode & 0o777).toBe(0o700);

    const unsafeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-user-data-link-'));
    const unsafeRoot = path.join(unsafeAppData, 'runtime');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-outside-'));
    fs.mkdirSync(unsafeRoot);
    fs.symlinkSync(outside, path.join(unsafeRoot, 'functions'));

    try {
      await expect(prepareLinuxRuntimePaths(unsafeAppData)).rejects.toThrow(/real app-owned directories/);
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
      fs.rmSync(unsafeAppData, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
