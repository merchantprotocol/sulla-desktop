// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainerHealPlanner, UserStoppedContainers } from '../sullaContainerHealth';
import { ManagedContainerHealthWatcher } from './ManagedContainerHealthWatcher';

class Cancelled extends Error {}

describe('ManagedContainerHealthWatcher', () => {
  let execCommand: ReturnType<typeof vi.fn>;
  let repairHostRelay: ReturnType<typeof vi.fn>;
  let userStopped: UserStoppedContainers;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    repairHostRelay = vi.fn(async() => undefined);
    userStopped = new UserStoppedContainers();
    execCommand = vi.fn(async(_options: unknown, ...command: string[]) => {
      if (command[1] === 'ps') return 'sulla_redis\tsulla\tredis\nunrelated\tother\tx\n';
      if (command[1] === 'inspect') return `running healthy ${ new Date().toISOString() }`;

      return '';
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function watcher(planner = new ContainerHealPlanner()) {
    return new ManagedContainerHealthWatcher({ execCommand } as any, userStopped, repairHostRelay, error => error instanceof Cancelled, planner);
  }

  it('first sweeps after 45 seconds and reports desired containers that are not running', async() => {
    const onMissing = vi.fn();

    watcher().watch(() => undefined, ['docker', 'compose'], [
      { service: 'redis', container: 'sulla_redis' }, { service: 'tools', container: 'sulla_tools' },
    ], onMissing);
    await vi.advanceTimersByTimeAsync(44_000);
    expect(execCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onMissing).toHaveBeenCalledWith([{ service: 'tools', container: 'sulla_tools' }]);
    // only the managed container is inspected
    expect(execCommand.mock.calls.filter(call => call[2] === 'inspect')).toHaveLength(1);
  });

  // risk: irreversible side effect — a container the person stopped must stay stopped.
  it('does not report a container the person stopped as missing', async() => {
    const onMissing = vi.fn();

    userStopped.record('stop', ['sulla_tools']);
    watcher().watch(() => undefined, ['docker', 'compose'], [{ service: 'tools', container: 'sulla_tools' }], onMissing);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it('stops ticking once the generation is cancelled', async() => {
    const assertGeneration = vi.fn(() => { throw new Cancelled() });

    watcher().watch(assertGeneration, ['docker', 'compose'], [], vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(assertGeneration).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(assertGeneration).toHaveBeenCalledTimes(1);
  });

  it('restarts with docker, repairs the host relay via its launcher and recreates compose services', async() => {
    const health = watcher();

    await health.runHealAction({ kind: 'restart', container: 'sulla_redis' } as any, ['docker', 'compose']);
    expect(execCommand).toHaveBeenLastCalledWith({ root: true }, 'docker', 'restart', '--time', '10', 'sulla_redis');
    await health.runHealAction({ kind: 'recreate', managedBy: 'docker', container: 'relay', service: 'relay' } as any, ['docker', 'compose']);
    expect(repairHostRelay).toHaveBeenCalledOnce();
    await health.runHealAction({ kind: 'recreate', managedBy: 'compose', container: 'sulla_redis', service: 'redis' } as any, ['docker', 'compose']);
    expect(execCommand).toHaveBeenLastCalledWith({ root: true }, 'docker', 'compose', 'up', '-d', '--no-deps', '--force-recreate', 'redis');
    execCommand.mockClear();
    await health.runHealAction({ kind: 'give-up', container: 'x' } as any, ['docker', 'compose']);
    expect(execCommand).not.toHaveBeenCalled();
  });
});
