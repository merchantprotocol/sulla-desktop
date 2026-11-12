// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../containerClient/mobyClient', () => ({ MobyClient: class {} }));

import { State } from '../backend';

import { prepareLinuxRuntimePaths, LinuxDockerHost } from './dockerHost';
import { LinuxContainerExecutor, DockerCli } from './linuxContainerExecutor';
import { LinuxRuntimeComposeBuilder } from './linuxRuntimeCompose';
import { LinuxDockerBackend, LINUX_CONTAINER_NAME } from './linuxVmBackend';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const config: any = { virtualMachine: { numberCPUs: 2, memoryInGB: 2 } };

function setup(overrides: { rootless?: boolean; composeUp?: number } = {}) {
  const calls: string[][] = [];
  const run = vi.fn(async(args: string[]) => {
    calls.push(args);
    if (args[0] === 'compose' && args[1] === 'version') return ok('2.30.0');
    if (args[0] === 'context') return ok('unix:///run/user/1000/docker.sock');
    if (args[0] === 'info') return ok(overrides.rootless === false ? '["name=seccomp"]' : '["name=rootless"]');
    if (args.includes('up')) return { stdout: '', stderr: '', exitCode: overrides.composeUp ?? 0 };

    return ok();
  });
  const cliCalls: string[][] = [];
  const cli: DockerCli = { run: async(args) => { cliCalls.push(args); return ok(); }, spawn: () => ({}) as any };
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-linux-be-'));
  const created: string[] = [];
  const backend = new LinuxDockerBackend({ appDataDirectory: appData }, {
    host:                new LinuxDockerHost(run),
    composeBuilder:      new LinuxRuntimeComposeBuilder(),
    executor:            new LinuxContainerExecutor(cli, LINUX_CONTAINER_NAME),
    preparePaths:        prepareLinuxRuntimePaths,
    engineClientFactory: (_e, endpoint) => { created.push(endpoint); return {} as any; },
  });

  return { backend, calls, cliCalls, appData, created };
}

describe('LinuxDockerBackend', () => {
  it('reports the truthful backend class and the executor targets the owned container', () => {
    const { backend } = setup();

    expect(backend.backend).toBe('linux-docker');
    expect(backend.executor.backend).toBe('linux-docker');
  });

  it('starts: verifies rootless, writes the compose file, runs compose up --wait, probes the container, reaches STARTED', async() => {
    const { backend, calls, cliCalls, appData, created } = setup();
    const states: State[] = [];

    backend.on('state-changed', s => states.push(s));
    await backend.start(config);

    expect(states).toEqual([State.STARTING, State.STARTED]);
    expect(calls.find(a => a.includes('up'))).toEqual(expect.arrayContaining(['--detach', '--wait', '--project-name', 'sulla-desktop-linux']));
    expect(fs.existsSync(path.join(appData, 'runtime', 'compose', 'docker-compose.json'))).toBe(true);
    expect(cliCalls[0]).toEqual(['exec', LINUX_CONTAINER_NAME, 'true']);
    expect(created).toEqual(['unix:///run/user/1000/docker.sock']);
    expect(await backend.ipAddress).toBe('127.0.0.1');
    expect(await backend.cpus).toBe(2);
    expect(backend.containerEngineClient).toBeDefined();
  });

  it('refuses to start on rootful Docker: ERROR state, no compose up (risk: host-root exposure)', async() => {
    const { backend, calls } = setup({ rootless: false });

    await expect(backend.start(config)).rejects.toThrow(/rootless/);
    expect(backend.state).toBe(State.ERROR);
    expect(calls.some(a => a.includes('up'))).toBe(false);
    expect(await backend.cpus).toBe(0);
    expect(() => backend.containerEngineClient).toThrow();
    expect((await backend.getFailureDetails(undefined)).lastLogLines[0]).toMatch(/rootless/);
  });

  it('surfaces a compose failure as ERROR rather than success', async() => {
    const { backend } = setup({ composeUp: 1 });

    await expect(backend.start(config)).rejects.toThrow(/could not start/);
    expect(backend.state).toBe(State.ERROR);
  });

  it('stop runs compose down without volumes and returns to STOPPED; stop when stopped is a no-op', async() => {
    const { backend, calls } = setup();

    await backend.stop();
    expect(calls.some(a => a.includes('down'))).toBe(false);
    await backend.start(config);
    await backend.stop();
    const down = calls.find(a => a.includes('down'))!;

    expect(down).toContain('--remove-orphans');
    expect(down).not.toContain('--volumes');
    expect(backend.state).toBe(State.STOPPED);
    expect(await backend.ipAddress).toBeUndefined();
  });

  it('start while started restarts (down then up), serialized', async() => {
    const { backend, calls } = setup();

    await backend.start(config);
    await backend.start(config);
    const order = calls.filter(a => a.includes('up') || a.includes('down')).map(a => (a.includes('up') ? 'up' : 'down'));

    expect(order).toEqual(['up', 'down', 'up']);
  });

  it('reset is explicitly unsupported and never touches Docker', async() => {
    const { backend, calls } = setup();

    await expect(backend.reset(config)).rejects.toThrow(/not supported/);
    expect(calls).toEqual([]);
  });

  it('requires restart when CPU/memory differ from the running config', async() => {
    const { backend } = setup();

    await backend.start(config);
    expect(await backend.requiresRestartReasons({ virtualMachine: { numberCPUs: 4 } } as any)).toEqual({
      'virtualMachine.numberCPUs': { current: 2, desired: 4, severity: 'restart' },
    });
    expect(await backend.requiresRestartReasons({ virtualMachine: { numberCPUs: 2 } } as any)).toEqual({});
  });

  it('getBackendInvalidReason reports missing prerequisites', async() => {
    const { backend } = setup({ rootless: false });
    const reason = await backend.getBackendInvalidReason();

    expect(os.platform() === 'linux' ? reason?.message : 'rootless').toMatch(/rootless/);
  });
});
