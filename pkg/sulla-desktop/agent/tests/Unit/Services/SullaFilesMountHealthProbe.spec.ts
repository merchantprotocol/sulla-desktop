// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { Clock } from '@sulla/foundation';
import {
  type GuestCommandResult,
  type GuestCommandRunOptions,
  type GuestCommandRunner,
  type GuestProcessSpawner,
  type MountAvailabilityView,
  SullaFilesBindPlanner,
  SullaFilesMountHealthProbe,
  SullaRuntimeGuestCommandRunner,
} from '@pkg/agent/services/SullaFilesMountHealthProbe';

/** A minimal stand-in for a ChildProcessWithoutNullStreams the production class actually uses. */
class FakeGuestProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: () => undefined };
  killed = false;
  kill(signal: string): boolean { this.killed = true; this.emit('__killed', signal); return true }
}

class FakeClock implements Clock {
  private millis = 0;
  now(): Date { return new Date(this.millis) }
  advance(ms: number): void { this.millis += ms }
}

class FakeMountManager implements MountAvailabilityView {
  available = true;
  guestMountAvailable(): boolean { return this.available }
}

/** Queues scripted results and records every guest command issued. */
class ScriptedGuestCommandRunner implements GuestCommandRunner {
  calls: { argv: string[]; options?: GuestCommandRunOptions }[] = [];
  private queue: GuestCommandResult[] = [];
  private pendingResolvers: ((result: GuestCommandResult) => void)[] = [];
  private holdNext = false;

  enqueue(result: GuestCommandResult): void { this.queue.push(result) }
  /** The next run() call will not resolve until releaseHeld() fires. */
  holdNextCall(): void { this.holdNext = true }
  releaseHeld(result: GuestCommandResult): void {
    const resolve = this.pendingResolvers.shift();
    if (resolve) resolve(result);
  }

  run(argv: string[], options?: GuestCommandRunOptions): Promise<GuestCommandResult> {
    this.calls.push({ argv, options });
    if (this.holdNext) {
      this.holdNext = false;
      return new Promise(resolve => this.pendingResolvers.push(resolve));
    }
    const next = this.queue.shift();
    if (!next) throw new Error('ScriptedGuestCommandRunner: no queued result for this call');
    return Promise.resolve(next);
  }
}

describe('SullaRuntimeGuestCommandRunner', () => {
  it('kills a hung sulla-runtime exec process once timeoutMs elapses and reports a timeout', async() => {
    // risk: a wedged guest exec blocks every future agent launch forever instead of being killed and reported
    const proc = new FakeGuestProcess();
    const spawner: GuestProcessSpawner = () => proc as unknown as ReturnType<GuestProcessSpawner>;
    const runner = new SullaRuntimeGuestCommandRunner('/usr/local/bin/sulla-runtime', spawner);

    const resultPromise = runner.run(['sh', '-c', 'sleep 999'], { timeoutMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(proc.killed).toBe(true);
    proc.emit('close', null);

    const result = await resultPromise;
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('timed out');
  });

  it('passes exec -- <argv> to the sulla-runtime binary and resolves stdout/stderr/code from the real process', async() => {
    // risk: the runner silently drops argv or swaps the binary path, breaking every guest command
    const proc = new FakeGuestProcess();
    let spawnedCommand = '';
    let spawnedArgs: readonly string[] = [];
    const spawner: GuestProcessSpawner = (command, args) => {
      spawnedCommand = command;
      spawnedArgs = args;
      return proc as unknown as ReturnType<GuestProcessSpawner>;
    };
    const runner = new SullaRuntimeGuestCommandRunner('/usr/local/bin/sulla-runtime', spawner);

    const resultPromise = runner.run(['docker', 'ps']);
    proc.stdout.emit('data', 'line1\n');
    proc.stderr.emit('data', 'warn\n');
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(spawnedCommand).toBe('/usr/local/bin/sulla-runtime');
    expect(spawnedArgs).toEqual(['exec', '--', 'docker', 'ps']);
    expect(result).toEqual({ code: 0, stdout: 'line1\n', stderr: 'warn\n' });
  });
});

describe('SullaFilesMountHealthProbe', () => {
  it('reports available when the guest probe succeeds and the planner keeps the Files bind', async() => {
    // risk: agent containers silently lose the Files bind on a healthy mount
    const runner = new ScriptedGuestCommandRunner();
    runner.enqueue({ code: 0, stdout: '', stderr: '' });
    const probe = new SullaFilesMountHealthProbe(new FakeMountManager(), runner, new FakeClock());

    const result = await probe.check();
    expect(result).toEqual({ available: true });

    const plan = await new SullaFilesBindPlanner(probe).plan();
    expect(plan.binds).toEqual(['/mnt/sulla-files:/mnt/sulla-files:rslave']);
    expect(plan.env).toEqual({ SULLA_FILES_AVAILABLE: '1' });
    expect(plan.warning).toBeUndefined();
  });

  it('reports unavailable with the real stderr when the guest mount is dead (ENOTCONN) and the planner drops the bind', async() => {
    // risk: agent launches crash-loop trying to bind a dead FUSE mount instead of starting without Files
    const runner = new ScriptedGuestCommandRunner();
    runner.enqueue({ code: 1, stdout: '', stderr: 'ls: /mnt/sulla-files: Transport endpoint is not connected\n' });
    const probe = new SullaFilesMountHealthProbe(new FakeMountManager(), runner, new FakeClock());

    const result = await probe.check();
    expect(result.available).toBe(false);
    expect(result.reason).toContain('Transport endpoint is not connected');

    const plan = await new SullaFilesBindPlanner(probe).plan();
    expect(plan.binds).toEqual([]);
    expect(plan.env).toEqual({
      SULLA_FILES_AVAILABLE:           '0',
      SULLA_FILES_UNAVAILABLE_REASON:  'ls: /mnt/sulla-files: Transport endpoint is not connected',
    });
    expect(plan.warning).toContain('Transport endpoint is not connected');
  });

  it('treats a hung guest probe as dead once the host-side timeout fires, with a clear reason', async() => {
    // risk: a wedged FUSE adapter hangs every future agent launch instead of being treated as down
    const runner: GuestCommandRunner = {
      run: () => new Promise(resolve => {
        // Never resolves on its own; the real runner is the one that enforces
        // timeoutMs by killing the process. Here we assert the probe still
        // gets a definitive answer by simulating what a timed-out run reports.
        setTimeout(() => resolve({ code: -1, stdout: '', stderr: 'guest command timed out' }), 5);
      }),
    };
    const probe = new SullaFilesMountHealthProbe(new FakeMountManager(), runner, new FakeClock(), undefined, 3_000);

    const result = await probe.check();
    expect(result).toEqual({ available: false, reason: 'Sulla Files probe timed out after 3s' });
  });

  it('treats a guest-side `timeout -s KILL` kill (exit 137, no stderr) the same as a host-side timeout', async() => {
    // risk: the guest's own timeout wrapper kills the wedged stat/ls, but the probe reports a bare, unhelpful exit code instead of "timed out"
    const runner = new ScriptedGuestCommandRunner();
    runner.enqueue({ code: 137, stdout: '', stderr: '' });
    const probe = new SullaFilesMountHealthProbe(new FakeMountManager(), runner, new FakeClock(), undefined, 3_000);

    const result = await probe.check();
    expect(result).toEqual({ available: false, reason: 'Sulla Files probe timed out after 3s' });
  });

  it('wraps the guest probe commands in a configurable `timeout -s KILL` so a wedged guest process is killed, not just abandoned', async() => {
    // risk: without a guest-side kill, a hung FUSE call leaves another stuck process in the guest on every launch
    const runner = new ScriptedGuestCommandRunner();
    runner.enqueue({ code: 0, stdout: '', stderr: '' });
    const probe = new SullaFilesMountHealthProbe(new FakeMountManager(), runner, new FakeClock(), undefined, 3_000, 2);

    await probe.check();

    expect(runner.calls).toHaveLength(1);
    const [script] = runner.calls[0].argv.slice(2, 3);
    expect(script).toContain('timeout -s KILL "$t"');
    expect(runner.calls[0].argv).toContain('2');
  });

  it('never runs a guest command when the mount manager flag is false', async() => {
    // risk: probing a VM that knows its own anchor is gone wastes a guest exec on every launch
    const runner = new ScriptedGuestCommandRunner();
    const manager = new FakeMountManager();
    manager.available = false;
    const probe = new SullaFilesMountHealthProbe(manager, runner, new FakeClock());

    const result = await probe.check();
    expect(result).toEqual({ available: false, reason: 'Sulla Files mount is not attached' });
    expect(runner.calls).toHaveLength(0);
  });

  it('caches a probe result for cacheTtlMs and re-probes (recovering) once it expires', async() => {
    // risk: 10 parallel agent launches each pay the guest-exec cost, or a recovered mount stays marked dead forever
    const runner = new ScriptedGuestCommandRunner();
    runner.enqueue({ code: 1, stdout: '', stderr: 'Transport endpoint is not connected' });
    runner.enqueue({ code: 0, stdout: '', stderr: '' });
    const clock = new FakeClock();
    const probe = new SullaFilesMountHealthProbe(new FakeMountManager(), runner, clock, 5_000);

    const first = await probe.check();
    expect(first.available).toBe(false);

    clock.advance(1_000);
    const stillCached = await probe.check();
    expect(stillCached.available).toBe(false);
    expect(runner.calls).toHaveLength(1);

    clock.advance(4_001);
    const recovered = await probe.check();
    expect(recovered).toEqual({ available: true });
    expect(runner.calls).toHaveLength(2);

    const plan = await new SullaFilesBindPlanner(probe).plan();
    expect(plan.binds).toEqual(['/mnt/sulla-files:/mnt/sulla-files:rslave']);
  });

  it('shares a single in-flight probe across concurrent callers instead of running one each', async() => {
    // risk: a burst of hidden-agent launches each fire their own guest exec against an already-dead mount
    const runner = new ScriptedGuestCommandRunner();
    runner.holdNextCall();
    const probe = new SullaFilesMountHealthProbe(new FakeMountManager(), runner, new FakeClock());

    const first = probe.check();
    const second = probe.check();
    const third = probe.check();
    expect(runner.calls).toHaveLength(1);

    runner.releaseHeld({ code: 0, stdout: '', stderr: '' });
    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
    expect(firstResult).toEqual({ available: true });
    expect(secondResult).toEqual({ available: true });
    expect(thirdResult).toEqual({ available: true });
    expect(runner.calls).toHaveLength(1);
  });
});
