// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  ContainerHealPlanner, HEALTHY_RESET_MS, MAX_AUTO_RECREATES, STATEFUL_GRACE_MS, STATELESS_GRACE_MS,
  type ManagedContainerRow,
} from '@pkg/backend/sullaContainerHealth';

const MIN = 60_000;

function row(overrides: Partial<ManagedContainerRow>): ManagedContainerRow {
  return {
    container: 'sulla_tools', service: 'sulla_tools', state: 'running', health: 'healthy', runningForMs: 30 * MIN, ...overrides,
  };
}

const healthyDeps = [
  row({ container: 'sulla_postgres', service: 'postgres' }),
  row({ container: 'sulla_redis', service: 'redis' }),
];

describe('ContainerHealPlanner', () => {
  // risk: irreversible side effect — a container that stays unhealthy must be restarted, then recreated, then left alone
  it('restarts first, recreates when the restart did not help, and stops at the cap', () => {
    const planner = new ContainerHealPlanner();
    const unhealthy = [...healthyDeps, row({ health: 'unhealthy', runningForMs: 2 * MIN })];
    const kinds: string[] = [];

    for (let tick = 0; tick < MAX_AUTO_RECREATES + 3; tick++) {
      kinds.push(...planner.plan(unhealthy).map(action => action.kind));
    }

    expect(kinds).toEqual(['restart', ...Array(MAX_AUTO_RECREATES).fill('recreate'), 'give-up']);
  });

  // risk: data loss — a slow first-start migration must never be interrupted
  it('waits out the grace period from the last start, longer for stateful services', () => {
    const planner = new ContainerHealPlanner();

    expect(planner.plan([...healthyDeps, row({ health: 'unhealthy', runningForMs: STATELESS_GRACE_MS - 1 })])).toEqual([]);
    expect(planner.plan([...healthyDeps, row({
      container: 'sulla_files', service: 'sulla_files', health: 'unhealthy', runningForMs: STATEFUL_GRACE_MS - 1,
    })])).toEqual([]);
    expect(planner.plan([...healthyDeps, row({
      container: 'sulla_files', service: 'sulla_files', health: 'unhealthy', runningForMs: STATEFUL_GRACE_MS,
    })]).map(action => action.kind)).toEqual(['restart']);
  });

  // risk: cascading restarts — dependents are not touched while Postgres or Redis is down
  it('heals only the dependency while postgres is unhealthy', () => {
    const planner = new ContainerHealPlanner();
    const actions = planner.plan([
      row({ container: 'sulla_postgres', service: 'postgres', health: 'unhealthy', runningForMs: STATEFUL_GRACE_MS }),
      row({ container: 'sulla_redis', service: 'redis' }),
      row({ health: 'unhealthy' }),
      row({ container: 'sulla_files_fuse', service: 'sulla_files_fuse', health: 'unhealthy' }),
    ]);

    expect(actions.map(action => action.container)).toEqual(['sulla_postgres']);
  });

  it('holds dependents while redis is still starting, then heals them once it is healthy', () => {
    const planner = new ContainerHealPlanner();
    const tools = row({ health: 'unhealthy' });

    expect(planner.plan([healthyDeps[0], row({ container: 'sulla_redis', service: 'redis', health: 'starting' }), tools])).toEqual([]);
    expect(planner.plan([...healthyDeps, tools]).map(action => action.container)).toEqual(['sulla_tools']);
  });

  // risk: endless restarts of a deliberately stopped on-demand service
  it('leaves stopped containers alone even when their last health was unhealthy', () => {
    const planner = new ContainerHealPlanner();

    expect(planner.plan([...healthyDeps, row({ state: 'exited', health: 'unhealthy' }), row({ container: 'x', state: 'dead', health: 'unhealthy' })])).toEqual([]);
  });

  it('recreates a restart-looping container and a stuck Files adapter straight away', () => {
    const planner = new ContainerHealPlanner();
    const actions = planner.plan([
      ...healthyDeps,
      row({ state: 'restarting', health: 'starting' }),
      row({ container: 'sulla_files_fuse', service: 'sulla_files_fuse', state: 'created', health: 'none', runningForMs: 0 }),
    ]);

    expect(actions.map(action => [action.container, action.kind, action.reason])).toEqual([
      ['sulla_tools', 'recreate', 'restart loop'],
      ['sulla_files_fuse', 'recreate', 'stuck created'],
    ]);
  });

  it('starts a fresh incident after the container stays healthy long enough', () => {
    const planner = new ContainerHealPlanner();

    planner.plan([...healthyDeps, row({ health: 'unhealthy' })]);
    planner.plan([...healthyDeps, row({ health: 'healthy', runningForMs: HEALTHY_RESET_MS - 1 })]);
    expect(planner.attempts('sulla_tools')).toBe(1);
    planner.plan([...healthyDeps, row({ health: 'healthy', runningForMs: HEALTHY_RESET_MS })]);
    expect(planner.attempts('sulla_tools')).toBe(0);
    expect(planner.plan([...healthyDeps, row({ health: 'unhealthy' })]).map(action => action.kind)).toEqual(['restart']);
  });

  it('marks containers Desktop runs directly so they are repaired outside compose', () => {
    const planner = new ContainerHealPlanner();
    const relay = row({ container: 'sulla-host-relay', service: 'sulla-host-relay', managedBy: 'docker', health: 'unhealthy' });

    expect(planner.plan([...healthyDeps, relay])[0]).toMatchObject({ managedBy: 'docker', kind: 'restart', attempt: 1 });
    expect(planner.plan([...healthyDeps, relay])[0]).toMatchObject({ managedBy: 'docker', kind: 'recreate', attempt: 2 });
  });
});
