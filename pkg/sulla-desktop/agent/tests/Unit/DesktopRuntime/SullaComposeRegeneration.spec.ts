// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ContainerDriftReconciler } from '@pkg/backend/ContainerDriftReconciler';
import type { ComposeServiceTarget, DockerCli } from '@pkg/backend/sullaComposeContainers';
import { SullaComposeRegeneration } from '@pkg/backend/SullaComposeRegeneration';

const COMPOSE = ['compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'];

const TARGETS: ComposeServiceTarget[] = [
  { service: 'postgres', container: 'sulla_postgres' },
  { service: 'sulla_vault', container: 'sulla_vault' },
  { service: 'workflow_manager', container: 'sulla_workflow_manager' },
  { service: 'tools', container: 'sulla_tools' },
  { service: 'sulla_files', container: 'sulla_files' },
];

/**
 * A guest where `compose config --hash` reports what the compose file on
 * disk wants and each container carries the hash it was created from.
 * Writing the compose file changes the desired hashes; a recreate stamps the
 * container with the current desired hash, as compose does.
 */
class Guest implements DockerCli {
  desired = new Map<string, string>();
  readonly running = new Map<string, string>();
  readonly recreated: string[] = [];

  async run(args: string[]): Promise<string> {
    if (args[0] === 'compose') {
      const service = args[args.length - 1];

      return this.desired.has(service) ? `${ service } ${ this.desired.get(service) }\n` : '';
    }
    if (args[0] === 'inspect') {
      const container = args[args.length - 1];

      if (!this.running.has(container)) throw new Error('No such object');

      return `true ${ this.running.get(container) }\n`;
    }
    throw new Error(`unexpected docker ${ args.join(' ') }`);
  }

  async recreate(service: string): Promise<void> {
    const target = TARGETS.find(entry => entry.service === service)!;

    this.recreated.push(service);
    this.running.set(target.container, this.desired.get(service)!);
  }

  /** Boot: every container runs the definition of the first compose file. */
  boot(hashes: Record<string, string>): void {
    this.desired = new Map(Object.entries(hashes));
    for (const target of TARGETS) this.running.set(target.container, hashes[target.service]);
  }
}

function regenerationWith(guest: Guest, nextFile: Record<string, string>) {
  const silent = { log: () => undefined, warn: () => undefined };
  const drift = new ContainerDriftReconciler(guest, COMPOSE, service => guest.recreate(service), silent);

  return new SullaComposeRegeneration(async() => {
    guest.desired = new Map(Object.entries(nextFile));

    return TARGETS;
  }, drift, silent);
}

const BOOT = { postgres: 'pg-1', sulla_vault: 'vault-1', workflow_manager: 'wm-1', tools: 'tools-1', sulla_files: 'files-1' };

describe('SullaComposeRegeneration (mid-session compose rewrite)', () => {
  // risk: sign-in — 07:26 regeneration: tools/vault/workflow_manager kept running on a definition other than the file's
  it('recreates every running container whose definition changed, including tools, vault and workflow_manager', async() => {
    const guest = new Guest();

    guest.boot(BOOT);
    const outcomes = await regenerationWith(guest, {
      ...BOOT, sulla_vault: 'vault-2', workflow_manager: 'wm-2', tools: 'tools-2',
    }).run('test');

    expect(guest.recreated.sort()).toEqual(['sulla_vault', 'tools', 'workflow_manager']);
    expect(outcomes.find(outcome => outcome.service === 'sulla_files')?.kind).toBe('unchanged');
    expect(outcomes.find(outcome => outcome.service === 'postgres')?.kind).toBe('unchanged');
    for (const target of TARGETS) expect(guest.running.get(target.container)).toBe(guest.desired.get(target.service));
  });

  // risk: availability — a regeneration that changed nothing must not restart anything
  it('recreates nothing when the regenerated file matches every running container', async() => {
    const guest = new Guest();

    guest.boot(BOOT);
    await regenerationWith(guest, BOOT).run('test');

    expect(guest.recreated).toEqual([]);
  });

  // risk: availability — the caller's own step (Files mount check, workflow_manager up) runs before the sweep; a superseded run stops
  it('runs beforeSweep after writing the file and stops when superseded', async() => {
    const guest = new Guest();
    const order: string[] = [];

    guest.boot(BOOT);
    const regeneration = regenerationWith(guest, { ...BOOT, tools: 'tools-2' });

    await expect(regeneration.run('test', {
      beforeSweep: async() => {
        order.push('beforeSweep');
      },
      checkpoint: () => {
        if (order.length > 0) throw new Error('superseded');
      },
    })).rejects.toThrow('superseded');
    expect(order).toEqual(['beforeSweep']);
    expect(guest.recreated).toEqual([]);
  });
});
