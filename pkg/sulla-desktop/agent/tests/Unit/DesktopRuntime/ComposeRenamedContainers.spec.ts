// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  ComposeContainerNameReconciler, ComposeServiceHealthWaiter, type DockerCli, type WaitClock,
} from '@pkg/backend/sullaComposeContainers';
import { MIGRATION_MARKER, NamedVolumeMigrator, type NamedVolumeSpec } from '@pkg/backend/sullaVolumeMigration';

interface FakeContainer {
  id: string;
  name: string;
  project: string;
  service: string;
  state: string;
  health: string;
  image: string;
  mounts: Array<{ Type: string; Name?: string; Destination: string }>;
}

/**
 * A small in-memory Docker engine: just enough of the CLI (ps, inspect, rename,
 * rm, volume create/inspect and helper `run` containers) to drive the real
 * reconciler, health waiter and volume migrator.
 */
class FakeDockerEngine implements DockerCli {
  readonly containers: FakeContainer[] = [];
  readonly volumes = new Map<string, Map<string, string>>();
  readonly calls: string[][] = [];
  failRename = false;
  /** Drop this file from the copy, to simulate a copy that did not complete. */
  dropOnCopy?: string;

  addContainer(container: Partial<FakeContainer> & { id: string; name: string; service: string }): FakeContainer {
    const full: FakeContainer = {
      project: 'sulla', state: 'running', health: 'healthy', image: 'sha256:redis', mounts: [], ...container,
    };

    this.containers.push(full);

    return full;
  }

  addVolume(name: string, files: Record<string, string> = {}): void {
    this.volumes.set(name, new Map(Object.entries(files)));
  }

  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    const [command, ...rest] = args;

    switch (command) {
    case 'ps': return this.ps(rest);
    case 'inspect': return this.inspect(rest);
    case 'rename': return this.rename(rest[0], rest[1]);
    case 'rm': {
      const id = rest[rest.length - 1];

      this.containers.splice(this.containers.indexOf(this.find(id)), 1);

      return '';
    }
    case 'volume': return this.volume(rest);
    case 'run': return this.runHelper(rest);
    default: throw new Error(`unexpected docker ${ args.join(' ') }`);
    }
  }

  private find(ref: string): FakeContainer {
    const container = this.containers.find(entry => entry.name === ref || entry.id === ref);

    if (!container) throw new Error(`Error: No such object: ${ ref }`);

    return container;
  }

  private ps(args: string[]): string {
    const labels = args.flatMap((arg, index) => args[index - 1] === '--filter' ? [arg.replace(/^label=/, '')] : []);

    return this.containers.filter(container => labels.every((label) => {
      const [key, value] = label.split('=');

      return key === 'com.docker.compose.project' ? container.project === value : container.service === value;
    })).map(container => `${ container.id }\t${ container.name }\t${ container.service }\t${ container.state }`).join('\n');
  }

  private inspect(args: string[]): string {
    const format = args[1];
    const container = this.find(args[2]);

    if (format.startsWith('{{json .Mounts}}')) return JSON.stringify(container.mounts);
    if (format === '{{.Image}}') return `${ container.image }\n`;

    return `${ container.state } ${ container.health }\n`;
  }

  private rename(ref: string, name: string): string {
    if (this.failRename) throw new Error('rename refused');
    if (this.containers.some(entry => entry.name === name)) throw new Error(`Conflict. The container name "/${ name }" is already in use`);
    this.find(ref).name = name;

    return '';
  }

  private volume(args: string[]): string {
    const name = args[args.length - 1];

    if (args[0] === 'inspect') {
      if (!this.volumes.has(name)) throw new Error(`no such volume: ${ name }`);

      return '[]';
    }
    if (args[0] === 'create') {
      if (!this.volumes.has(name)) this.volumes.set(name, new Map());

      return `${ name }\n`;
    }
    throw new Error(`unexpected docker volume ${ args.join(' ') }`);
  }

  private runHelper(args: string[]): string {
    const binds = new Map<string, string>();

    args.forEach((arg, index) => {
      if (args[index - 1] !== '-v') return;
      const [volume, path] = arg.split(':');

      binds.set(path, volume);
    });
    const script = args[args.length - 1];
    const at = (path: string): Map<string, string> => {
      const files = this.volumes.get(binds.get(path) ?? '');

      if (!files) throw new Error(`volume for ${ path } does not exist`);

      return files;
    };

    if (script.startsWith('find /to -mindepth 1 -delete && cp -a /from/. /to/')) {
      const to = at('/to');

      to.clear();
      for (const [file, content] of at('/from')) {
        if (file !== this.dropOnCopy) to.set(file, content);
      }

      return '';
    }
    if (script.startsWith('cd /v && find')) {
      return [...at('/v')].filter(([file]) => file !== MIGRATION_MARKER)
        .map(([file, content]) => `${ content.length }:${ content }  ./${ file }`)
        .sort((left, right) => left.split('  ')[1].localeCompare(right.split('  ')[1]))
        .join('\n');
    }
    if (script.startsWith('test -f /to/')) {
      if (!at('/to').has(MIGRATION_MARKER)) throw new Error('exit 1');

      return '';
    }
    const marker = /^echo (\S+) > \/to\/(\S+)$/.exec(script);

    if (marker) {
      at('/to').set(marker[2], marker[1]);

      return '';
    }
    throw new Error(`unexpected helper script ${ script }`);
  }
}

class FakeClock implements WaitClock {
  private time = 0;
  now(): number { return this.time }
  async sleep(ms: number): Promise<void> { this.time += ms }
}

const quiet = { warn: () => undefined };
const redis = { service: 'redis', container: 'sulla_redis' };
const STRAY = '952db432336d_sulla_redis';

function setup() {
  const docker = new FakeDockerEngine();
  const containers = new ComposeContainerNameReconciler(docker, 'sulla', quiet);
  const waiter = new ComposeServiceHealthWaiter(docker, containers, new FakeClock());

  return { docker, containers, waiter };
}

describe('ComposeContainerNameReconciler', () => {
  // risk: lost access — the exact incident: only `<id>_sulla_redis` exists, compose treats it as current
  it('renames a stray left by an interrupted re-create back, keeping its data volume', async() => {
    const { docker, containers } = setup();

    docker.addVolume('19870c22anon', { 'dump.rdb': 'keys' });
    docker.addContainer({ id: '952db432336dfull', name: STRAY, service: 'redis', mounts: [{ Type: 'volume', Name: '19870c22anon', Destination: '/data' }] });

    const actions = await containers.reconcile([redis]);

    expect(actions).toEqual([{ kind: 'renamed', service: 'redis', from: STRAY, to: 'sulla_redis' }]);
    expect(docker.containers.map(container => container.name)).toEqual(['sulla_redis']);
    expect(docker.containers[0].mounts[0].Name).toBe('19870c22anon');
    expect(docker.volumes.get('19870c22anon')?.get('dump.rdb')).toBe('keys');
  });

  // risk: data loss — when both exist the stray goes, but never with its volumes, and the current one stays
  it('keeps the container under the fixed name and removes the stray without its volumes', async() => {
    const { docker, containers } = setup();

    docker.addContainer({ id: 'newnewnewnew1', name: 'sulla_redis', service: 'redis', state: 'created', health: 'none' });
    docker.addContainer({ id: '952db432336dfull', name: STRAY, service: 'redis' });

    const actions = await containers.reconcile([redis]);

    expect(actions).toEqual([{ kind: 'removed-stray', service: 'redis', container: STRAY, kept: 'sulla_redis' }]);
    expect(docker.containers.map(container => container.id)).toEqual(['newnewnewnew1']);
    expect(docker.calls.find(call => call[0] === 'rm')).toEqual(['rm', '-f', '952db432336dfull']);
  });

  // risk: wrong container touched — only compose's exact `<12 hex>_<name>` of the same project and service qualifies
  it('leaves look-alike names, other services and other projects alone', async() => {
    const { docker, containers } = setup();

    docker.addContainer({ id: 'a1', name: 'backup_sulla_redis', service: 'redis' });
    docker.addContainer({ id: 'a2', name: '952db432336d_sulla_redis', service: 'postgres' });
    docker.addContainer({ id: 'a3', name: '952db432336e_sulla_redis', service: 'redis', project: 'other' });
    docker.addContainer({ id: 'a4', name: '952DB432336D_sulla_redis', service: 'redis' });

    expect(await containers.reconcile([redis])).toEqual([]);
    expect(docker.calls.filter(call => call[0] === 'rename' || call[0] === 'rm')).toEqual([]);
  });

  it('heals every fixed-name service in the prepared compose file', () => {
    expect(ComposeContainerNameReconciler.targetsOf({
      services: { redis: { container_name: 'sulla_redis' }, tools: { container_name: 'sulla_tools' }, scratch: { image: 'x' } },
    })).toEqual([redis, { service: 'tools', container: 'sulla_tools' }]);
  });
});

describe('ComposeServiceHealthWaiter', () => {
  // risk: lost access — the boot wait must succeed instead of reporting "not created" for 300 s
  it('finds a renamed container, renames it back and reports the service healthy', async() => {
    const { docker, waiter } = setup();

    docker.addContainer({ id: '952db432336dfull', name: STRAY, service: 'redis' });

    await expect(waiter.waitHealthy(redis, 300)).resolves.toBeUndefined();
    expect(docker.containers[0].name).toBe('sulla_redis');
  });

  // risk: lost access — even when the rename cannot happen, the wait resolves the container by its compose labels
  it('resolves the container by compose project and service labels when the name cannot be healed', async() => {
    const { docker, waiter } = setup();

    docker.failRename = true;
    docker.addContainer({ id: '952db432336dfull', name: STRAY, service: 'redis' });

    await expect(waiter.waitHealthy(redis, 300)).resolves.toBeUndefined();
    expect(docker.calls).toContainEqual(expect.arrayContaining(['inspect', '952db432336dfull']));
  });

  it('still waits for a starting container and times out with the last status when it never gets healthy', async() => {
    const { docker, waiter } = setup();

    docker.addContainer({ id: 'r1', name: 'sulla_redis', service: 'redis', health: 'starting' });

    await expect(waiter.waitHealthy(redis, 5)).rejects.toThrow('Docker service sulla_redis not healthy after 5s (last status: running starting)');
  });

  it('reports "not created" when no container runs the service at all', async() => {
    const { waiter } = setup();

    await expect(waiter.waitHealthy(redis, 5)).rejects.toThrow('(last status: not created)');
  });
});

describe('NamedVolumeMigrator', () => {
  const spec: NamedVolumeSpec = {
    ...redis, mountPath: '/data', volume: 'sulla_redis_data', composeVolume: 'sulla_redis_data',
  };

  function withAnonymousRedis() {
    const env = setup();
    const migrator = new NamedVolumeMigrator(env.docker, env.containers, 'sulla', quiet);

    env.docker.addVolume('19870c22anon', { 'dump.rdb': 'snapshot', 'appendonly.aof': 'log' });
    env.docker.addContainer({
      id: 'r1', name: 'sulla_redis', service: 'redis', mounts: [{ Type: 'volume', Name: '19870c22anon', Destination: '/data' }],
    });

    return { ...env, migrator };
  }

  // risk: data loss — data on the anonymous volume reaches the named volume before compose switches over
  it('copies the anonymous volume into the named volume, verifies it, and keeps the source', async() => {
    const { docker, migrator } = withAnonymousRedis();

    expect(await migrator.migrate(spec)).toEqual({ kind: 'migrated', source: '19870c22anon', files: 2 });
    expect(Object.fromEntries(docker.volumes.get('sulla_redis_data') ?? [])).toEqual({
      'dump.rdb': 'snapshot', 'appendonly.aof': 'log', [MIGRATION_MARKER]: '19870c22anon',
    });
    expect(Object.fromEntries(docker.volumes.get('19870c22anon') ?? [])).toEqual({ 'dump.rdb': 'snapshot', 'appendonly.aof': 'log' });
    expect(docker.calls).toContainEqual(['volume', 'create', '--label', 'com.docker.compose.project=sulla',
      '--label', 'com.docker.compose.volume=sulla_redis_data', 'sulla_redis_data']);
  });

  // risk: data loss — a second run must not copy again over data the service may already have written
  it('is idempotent: once migrated it never copies again, before or after compose switches the service', async() => {
    const { docker, migrator } = withAnonymousRedis();

    await migrator.migrate(spec);
    docker.volumes.get('sulla_redis_data')?.set('dump.rdb', 'newer');
    const copiesBefore = docker.calls.filter(call => call[0] === 'run' && call.at(-1)?.includes('cp -a')).length;

    expect(await migrator.migrate(spec)).toEqual({ kind: 'already-migrated' });
    docker.containers[0].mounts = [{ Type: 'volume', Name: 'sulla_redis_data', Destination: '/data' }];
    expect(await migrator.migrate(spec)).toEqual({ kind: 'already-migrated' });
    expect(docker.calls.filter(call => call[0] === 'run' && call.at(-1)?.includes('cp -a')).length).toBe(copiesBefore);
    expect(docker.volumes.get('sulla_redis_data')?.get('dump.rdb')).toBe('newer');
  });

  // risk: data loss — a copy that does not verify is never marked done and never costs the source
  it('fails without marking or deleting anything when the copy does not verify, then succeeds on retry', async() => {
    const { docker, migrator } = withAnonymousRedis();

    docker.dropOnCopy = 'appendonly.aof';
    await expect(migrator.migrate(spec)).rejects.toThrow('did not verify; the original volume is untouched');
    expect(docker.volumes.get('sulla_redis_data')?.has(MIGRATION_MARKER)).toBe(false);
    expect(docker.volumes.get('19870c22anon')?.size).toBe(2);
    expect(docker.calls.some(call => call[0] === 'volume' && call[1] === 'rm')).toBe(false);

    docker.dropOnCopy = undefined;
    expect(await migrator.migrate(spec)).toEqual({ kind: 'migrated', source: '19870c22anon', files: 2 });
  });

  it('does nothing on a fresh install or when the service already uses a bind or named mount', async() => {
    const fresh = setup();

    expect(await new NamedVolumeMigrator(fresh.docker, fresh.containers, 'sulla', quiet).migrate(spec)).toEqual({ kind: 'nothing-to-migrate' });

    const { docker, migrator } = withAnonymousRedis();

    docker.containers[0].mounts = [{ Type: 'bind', Destination: '/data' }];
    expect(await migrator.migrate(spec)).toEqual({ kind: 'nothing-to-migrate' });
    expect(docker.volumes.has('sulla_redis_data')).toBe(false);
  });

  // risk: data loss — the migration reads the stray's volume rather than starting empty
  it('migrates from a renamed stray after healing its name', async() => {
    const { docker, migrator } = withAnonymousRedis();

    docker.containers[0].name = STRAY;

    expect(await migrator.migrate(spec)).toMatchObject({ kind: 'migrated', source: '19870c22anon' });
    expect(docker.containers[0].name).toBe('sulla_redis');
  });
});
