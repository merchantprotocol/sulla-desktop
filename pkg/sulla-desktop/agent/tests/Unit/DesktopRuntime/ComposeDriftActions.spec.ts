// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { ComposeDriftActions } from '@pkg/backend/ComposeDriftActions';
import { ContainerDriftReconciler } from '@pkg/backend/ContainerDriftReconciler';
import type { ComposeServiceTarget, DockerCli } from '@pkg/backend/sullaComposeContainers';

vi.mock('@pkg/backend/onDemandServices', () => ({ SULLA_COMPOSE_COMMAND: ['docker', 'compose', '-p', 'sulla'] }));

const COMPOSE = ['compose', '-p', 'sulla'];
const FILES: ComposeServiceTarget = { service: 'sulla_files', container: 'sulla_files' };
const TOOLS: ComposeServiceTarget = { service: 'tools', container: 'sulla_tools' };

/** A guest where every container drifted from the compose file and is still in its start period. */
class StartingGuest implements DockerCli {
  async run(args: string[]): Promise<string> {
    if (args[0] === 'compose') return `${ args[args.length - 1] } desired-hash\n`;
    if (args[0] === 'inspect' && args[2].includes('.State.Health')) return 'starting\n';
    if (args[0] === 'inspect') return 'true running-hash\n';
    throw new Error(`unexpected docker ${ args.join(' ') }`);
  }
}

function sweep(waitHealthy: (target: ComposeServiceTarget, timeoutSec: number) => Promise<void>) {
  const silent = { log: () => undefined, warn: () => undefined };
  const guest = new StartingGuest();
  const actions = new ComposeDriftActions(guest, async() => undefined, waitHealthy, silent);
  const recreated: string[] = [];
  const drift = new ContainerDriftReconciler(guest, COMPOSE, async(service) => {
    recreated.push(service);
  }, silent, target => actions.settle(target));

  return { drift, recreated };
}

describe('ComposeDriftActions.settle (before a drift recreate)', () => {
  // risk: data accuracy — recreating Files mid-migration can leave its schema half applied
  it('skips the Files recreate when Files is still starting after its settle timeout', async() => {
    const { drift, recreated } = sweep(async() => {
      throw new Error('timed out waiting for sulla_files to become healthy');
    });

    const [outcome] = await drift.reconcileAll([FILES]);

    expect(recreated).toEqual([]);
    expect(outcome.kind).toBe('unknown');
  });

  // risk: data accuracy — the skipped recreate is retried by the next sweep, not marked as done
  it('a later sweep recreates Files once it settles', async() => {
    let healthy = false;
    const { drift, recreated } = sweep(async() => {
      if (!healthy) throw new Error('timed out');
    });

    await drift.reconcileAll([FILES]);
    healthy = true;
    await drift.reconcileAll([FILES]);

    expect(recreated).toEqual(['sulla_files']);
  });

  // risk: availability — a service without a migration still gets its new definition
  it('still recreates a service without a migration window when it does not settle', async() => {
    const { drift, recreated } = sweep(async() => {
      throw new Error('timed out');
    });

    await drift.reconcileAll([TOOLS]);

    expect(recreated).toEqual(['tools']);
  });
});
