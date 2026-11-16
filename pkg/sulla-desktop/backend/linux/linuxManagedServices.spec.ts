// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import yaml from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import { prepareLinuxRuntimePaths } from './dockerHost';
import { DesktopManagedServicesHooks } from './linuxDesktopHooks';
import {
  LINUX_SERVICES_PROJECT, LinuxManagedServices, LinuxServicesComposeBuilder, ManagedServicesHooks,
} from './linuxManagedServices';

const realCompose = () => yaml.parse(fs.readFileSync(path.join(__dirname, '../../assets/sulla-docker-compose.yaml'), 'utf8'));
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

async function paths() {
  return prepareLinuxRuntimePaths(fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-linux-svc-')));
}

describe('LinuxServicesComposeBuilder (real compose asset)', () => {
  it('keeps only core + on-demand services, loopback ports resolved to the instance offset, host-owned function mounts (risk: host exposure)', async() => {
    const p = await paths();
    const { document, services, deferred } = await new LinuxServicesComposeBuilder(realCompose).build({ paths: p, resolvePort: base => base + 100, servicePassword: 'pw' });

    expect(services.sort()).toEqual(['node_runtime', 'postgres', 'python_runtime', 'redis', 'shell_runtime']);
    expect(deferred).toEqual([]);
    expect(document.services!.postgres.ports).toEqual(['127.0.0.1:30216:5432']);
    expect(document.services!.python_runtime.volumes).toContain(`${ p.functionCatalog }:/var/functions:ro`);
    expect(document.services!.python_runtime.volumes).toContain(`${ p.functionInvocations }:/var/db-functions:ro`);
    for (const service of Object.values(document.services!)) {
      expect(service.restart).toBe('no');
      expect(JSON.stringify(service)).not.toMatch(/docker\.sock|privileged/);
    }
  });

  it('writes the database password compose-escaped (risk: password with $ corrupted or leaked into the wrong var)', async() => {
    const { document } = await new LinuxServicesComposeBuilder(realCompose).build({ paths: await paths(), resolvePort: b => b, servicePassword: 'p$w' });

    expect(document.services!.postgres.environment).toContain('POSTGRES_PASSWORD=p$$w');
  });

  it('drops services it cannot provision and reports them (risk: silently claiming unsupported services)', async() => {
    const base = realCompose();

    base.services.sulla_vault = { image: 'x', ports: ['127.0.0.1:30135:8787'] };
    const { document, deferred } = await new LinuxServicesComposeBuilder(() => base).build({ paths: await paths(), resolvePort: b => b, servicePassword: 'pw' });

    expect(deferred).toEqual(['sulla_vault']);
    expect(document.services!.sulla_vault).toBeUndefined();
  });

  it('refuses host path binds, the Docker socket, and non-loopback ports', async() => {
    const run = async(mutate: (c: any) => void) => {
      const base = realCompose();

      mutate(base);

      return new LinuxServicesComposeBuilder(() => base).build({ paths: await paths(), resolvePort: b => b, servicePassword: 'pw' });
    };

    await expect(run(c => c.services.python_runtime.volumes.push('/home/user/.ssh:/ssh'))).rejects.toThrow(/host bind mounts/);
    await expect(run(c => c.services.redis.volumes = ['/var/run/docker.sock:/var/run/docker.sock'])).rejects.toThrow(/Docker socket/);
    await expect(run(c => c.services.redis.ports = ['0.0.0.0:6379:6379'])).rejects.toThrow(/loopback/);
    await expect(run(c => c.services.redis.volumes = ['/mnt/data/other:/x'])).rejects.toThrow(/no app-owned Linux host directory/);
  });

  it('writes the compose file mode 0600 inside the private compose dir', async() => {
    const p = await paths();
    const { file } = await new LinuxServicesComposeBuilder(realCompose).write({ paths: p, resolvePort: b => b, servicePassword: 'pw' });

    expect(path.dirname(file)).toBe(p.compose);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });
});

function harness(options: { inspect?: (container: string) => string; upFails?: number } = {}) {
  const calls: string[][] = [];
  const events: string[] = [];
  let upFailuresLeft = options.upFails ?? 0;
  const hooks: ManagedServicesHooks = {
    backendBooted:     () => events.push('booted'),
    coreServicesReady: () => events.push('core'),
    servicesDeployed:  async() => { events.push('deployed') },
    servicesReady:     () => events.push('ready'),
    servicesFailed:    () => events.push('failed'),
  };
  let onDemandRun: ((args: string[]) => Promise<string>) | undefined;
  let cleared = false;
  const services = new LinuxManagedServices({
    docker: async(args) => {
      calls.push(args);
      if (args.includes('up') && upFailuresLeft > 0) { upFailuresLeft--; return { stdout: '', stderr: 'boom', exitCode: 1 } }
      if (args[0] === 'inspect') return ok(options.inspect ? options.inspect(args[args.length - 1]) : 'running healthy');

      return ok();
    },
    builder:        new LinuxServicesComposeBuilder(realCompose),
    hooks,
    composeOptions: async p => ({ paths: p, resolvePort: b => b, servicePassword: 'pw' }),
    configureOnDemand: (run) => { onDemandRun = run },
    clearOnDemand:     () => { cleared = true },
    sleep:             async() => undefined,
    logger:            { warn: () => undefined, log: () => undefined },
    retryDelaysMs:     [1],
    healthTimeoutSeconds: 1,
  });

  return { services, calls, events, onDemand: () => onDemandRun!, wasCleared: () => cleared };
}

describe('LinuxManagedServices', () => {
  it('brings up postgres+redis, waits for health, then signals core-ready before ready (risk: first-run proceeding on dead DB)', async() => {
    const h = harness();

    await h.services.prepare(await paths());
    await h.services.run();

    const up = h.calls.find(a => a.includes('up'))!;

    expect(up).toEqual(expect.arrayContaining(['--project-name', LINUX_SERVICES_PROJECT, 'up', 'postgres', 'redis']));
    expect(up).not.toContain('python_runtime');
    expect(h.calls.filter(a => a[0] === 'inspect').map(a => a[a.length - 1]).sort()).toEqual(['sulla_postgres', 'sulla_redis']);
    expect(h.events).toEqual(['booted', 'core', 'deployed', 'ready']);
  });

  it('never reports ready while a service stays unhealthy; reports failure after repeated attempts (risk: false "supported")', async() => {
    let now = 0;
    const h = harness({ inspect: () => 'running unhealthy' });
    // Replace clock: every sleep advances time past the health timeout.
    const services = new LinuxManagedServices({
      docker:   async(args) => (args[0] === 'inspect' ? ok('running unhealthy') : ok()),
      builder:  new LinuxServicesComposeBuilder(realCompose),
      hooks:    { backendBooted: () => h.events.push('booted'), coreServicesReady: () => h.events.push('core'), servicesDeployed: async() => undefined, servicesReady: () => h.events.push('ready'), servicesFailed: () => { h.events.push('failed'); void services.stop() } },
      composeOptions: async p => ({ paths: p, resolvePort: b => b, servicePassword: 'pw' }),
      sleep: async(ms) => { now += ms * 1000 },
      now:   () => now,
      logger: { warn: () => undefined, log: () => undefined },
      retryDelaysMs: [1], healthTimeoutSeconds: 1,
    });

    await services.prepare(await paths());
    await services.run();
    expect(h.events).toContain('failed');
    expect(h.events).not.toContain('ready');
    expect(h.events).not.toContain('core');
  });

  it('retries a failed compose up and then succeeds', async() => {
    const h = harness({ upFails: 2 });

    await h.services.prepare(await paths());
    await h.services.run();
    expect(h.calls.filter(a => a.includes('up')).length).toBe(3);
    expect(h.events.at(-1)).toBe('ready');
    expect(h.events).not.toContain('failed');
  });

  it('stop: down without volumes, clears on-demand runtimes, idempotent (risk: data loss)', async() => {
    const h = harness();

    await h.services.stop();
    expect(h.calls).toEqual([]);
    await h.services.prepare(await paths());
    await h.services.stop();
    await h.services.stop();
    const downs = h.calls.filter(a => a.includes('down'));

    expect(downs.length).toBe(2);
    expect(downs[0]).toContain('--remove-orphans');
    expect(downs[0]).not.toContain('--volumes');
    expect(h.wasCleared()).toBe(true);
  });

  it('on-demand runner maps the guest compose prefix to this project and refuses anything else (risk: arbitrary host commands)', async() => {
    const h = harness();

    await h.services.prepare(await paths());
    await h.onDemand()(['docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla', 'up', '-d', '--no-deps', 'python_runtime']);
    await h.onDemand()(['docker', 'stop', '-t', '10', 'sulla_python_runtime']);
    const compose = h.calls[0];

    expect(compose).toEqual(expect.arrayContaining(['--project-name', LINUX_SERVICES_PROJECT, 'up', '-d', '--no-deps', 'python_runtime']));
    expect(compose).not.toContain('/tmp/sulla-docker-compose.yml');
    expect(h.calls[1]).toEqual(['stop', '-t', '10', 'sulla_python_runtime']);
    await expect(h.onDemand()(['docker', 'run', '--privileged', 'alpine'])).rejects.toThrow(/Refused/);
    await expect(h.onDemand()(['sh', '-c', 'id'])).rejects.toThrow(/Refused/);
    await expect(h.onDemand()(['docker', 'compose', '-f', '/etc/evil.yml', '-p', 'x', 'up'])).rejects.toThrow(/Refused/);
  });

  it('run before prepare is an error, not a silent no-op', async() => {
    await expect(harness().services.run()).rejects.toThrow(/not prepared/);
  });
});

describe('DesktopManagedServicesHooks', () => {
  it('maps lifecycle to the first-run events and runs Sulla start between deploy and ready', async() => {
    const emitted: string[] = [];
    const startup = {
      markDockerServicesStarted: vi.fn(() => { emitted.push('marked') }),
      instantiateStart:          vi.fn(async() => { emitted.push('start') }),
      markInstalled:             vi.fn(async() => { emitted.push('installed') }),
    };
    const hooks = new DesktopManagedServicesHooks({ emit: e => emitted.push(e) }, startup);

    hooks.backendBooted();
    hooks.coreServicesReady();
    await hooks.servicesDeployed(() => undefined);
    hooks.servicesReady();
    hooks.servicesFailed();
    expect(emitted).toEqual(['first-run-backend-booted', 'first-run-ai-runtime-ready', 'marked', 'start', 'installed', 'sulla-managed-services-ready', 'sulla-managed-services-failed']);
  });

  it('a superseded generation aborts before Sulla start runs', async() => {
    const startup = { markDockerServicesStarted: vi.fn(), instantiateStart: vi.fn(async() => undefined), markInstalled: vi.fn(async() => undefined) };
    const hooks = new DesktopManagedServicesHooks({ emit: () => undefined }, startup);

    await expect(hooks.servicesDeployed(() => { throw new Error('superseded') })).rejects.toThrow('superseded');
    expect(startup.instantiateStart).not.toHaveBeenCalled();
  });
});
