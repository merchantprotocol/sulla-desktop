// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { GuestServiceSecretInstallState } from '@pkg/backend/GuestServiceSecretInstallState';
import type { DockerCli } from '@pkg/backend/sullaComposeContainers';

class Docker implements DockerCli {
  volumes: string[] = [];
  containers: string[] = [];
  failing = false;
  readonly calls: string[][] = [];

  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (this.failing) throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'volume') return `${ this.volumes.join('\n') }\n`;
    if (args[0] === 'ps') return `${ this.containers.join('\n') }\n`;
    if (args[0] === 'start') return '';
    throw new Error(`unexpected docker ${ args.join(' ') }`);
  }
}

function state(docker: Docker, events: string[] = []) {
  return new GuestServiceSecretInstallState(docker, async(target) => {
    events.push(`healthy ${ target.container }`);
  }, { bootstrap: async() => {
    events.push('bootstrap');
  } });
}

describe('GuestServiceSecretInstallState', () => {
  // risk: irreversible side effect — "fresh" is the only state that may generate a new service secret
  it('is fresh only when neither the PostgreSQL data volume nor its container exists', async() => {
    const docker = new Docker();

    docker.volumes = ['sulla_redis_data', 'sulla_sulla_python_runtime_cache'];
    expect(await state(docker).isFresh()).toBe(true);

    docker.volumes.push('sulla_sulla_postgres_data');
    expect(await state(docker).isFresh()).toBe(false);

    docker.volumes = [];
    docker.containers = ['sulla_postgres'];
    expect(await state(docker).isFresh()).toBe(false);
  });

  // risk: irreversible side effect — doubt is never "fresh"
  it('counts as installed when Docker does not answer', async() => {
    const docker = new Docker();

    docker.failing = true;
    expect(await state(docker).isFresh()).toBe(false);
  });

  // risk: data accuracy — the database is read only after PostgreSQL and Redis are healthy
  it('opens the database: starts PostgreSQL and Redis, waits for both, then bootstraps settings', async() => {
    const docker = new Docker();
    const events: string[] = [];

    await state(docker, events).openDatabase();

    expect(docker.calls).toContainEqual(['start', 'sulla_postgres', 'sulla_redis']);
    expect(events).toEqual(['healthy sulla_postgres', 'healthy sulla_redis', 'bootstrap']);
  });
});
