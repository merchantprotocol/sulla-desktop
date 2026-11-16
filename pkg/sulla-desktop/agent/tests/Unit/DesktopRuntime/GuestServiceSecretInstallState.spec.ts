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
  stored: string | null = null;
  readonly calls: string[][] = [];

  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (this.failing) throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'volume') return `${ this.volumes.join('\n') }\n`;
    if (args[0] === 'ps') return `${ this.containers.join('\n') }\n`;
    if (args[0] === 'start') return '';
    if (args[0] === 'exec') return this.stored === null ? '\n' : `${ this.stored }\n`;
    throw new Error(`unexpected docker ${ args.join(' ') }`);
  }
}

function state(docker: Docker, events: string[] = []) {
  return new GuestServiceSecretInstallState(docker, async(target) => {
    events.push(`healthy ${ target.container }`);
  });
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

  // risk: sign-in — the stored secret is read in the guest, after PostgreSQL is healthy, byte for byte
  it('reads the stored secret with psql after starting PostgreSQL and waiting for it', async() => {
    const docker = new Docker();
    const events: string[] = [];

    docker.stored = 'Stored|Secret with spaces';
    expect(await state(docker, events).readDatabaseSecret()).toBe('Stored|Secret with spaces');
    expect(docker.calls[0]).toEqual(['start', 'sulla_postgres']);
    expect(events).toEqual(['healthy sulla_postgres']);
    expect(docker.calls[1].slice(0, 2)).toEqual(['exec', 'sulla_postgres']);
  });

  // risk: irreversible side effect — an empty answer is "absent", never an empty password
  it('reports no stored secret as null', async() => {
    const docker = new Docker();

    expect(await state(docker).readDatabaseSecret()).toBeNull();
  });
});
