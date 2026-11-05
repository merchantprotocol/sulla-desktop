// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import type { ContainerSpec } from '@pkg/runtime/containerRuntime';
import { AgentContainerLaunchCoordinator, type AgentContainerDiagnosticRuntime, type AgentLaunchJobReporter } from '@pkg/agent/services/AgentContainerLaunchCoordinator';
import { IdempotentRetry, StartupRetryError } from '@pkg/agent/services/AgentContainerStartupRetry';
import { SullaFilesBindPlanner } from '@pkg/agent/services/SullaFilesMountHealthProbe';
import { GuestDockerRuntimeDriver, type GuestDockerCommandExecutor } from '@pkg/agent/services/GuestDockerRuntimeDriver';

class FakeRuntime implements AgentContainerDiagnosticRuntime {
  created: ContainerSpec[] = [];
  removed: string[] = [];
  stopped: string[] = [];
  renamed: string[] = [];
  starts = 0;
  startErrors: Error[] = [];
  renameConflicts = 0;
  create(spec: ContainerSpec): Promise<string> { this.created.push(spec); return Promise.resolve('container-1') }
  async start(): Promise<void> { const error = this.startErrors[this.starts++]; if (error) throw error }
  inspect(): Promise<any> { return Promise.resolve({}) }
  remove(id: string): Promise<void> { this.removed.push(id); return Promise.resolve() }
  list(): Promise<any[]> { return Promise.resolve([]) }
  stop(id: string): Promise<void> { this.stopped.push(id); return Promise.resolve() }
  rename(_id: string, name: string): Promise<void> {
    if (this.renameConflicts-- > 0) return Promise.reject(new Error('name is already in use'));
    this.renamed.push(name); return Promise.resolve();
  }
  logs(_id: string, tail?: number): Promise<string> { return Promise.resolve(`tail=${ tail }\nboom`) }
}

class FakeReporter implements AgentLaunchJobReporter {
  warnings: string[] = [];
  failures: string[] = [];
  warning(message: string): Promise<void> { this.warnings.push(message); return Promise.resolve() }
  failure(message: string): Promise<void> { this.failures.push(message); return Promise.resolve() }
}

class StderrOnlyDockerExecutor implements GuestDockerCommandExecutor {
  readonly commands: string[][] = [];
  execute(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push(args);
    if (args[0] === 'sh') return Promise.resolve({ stdout: '', stderr: 'fatal: startup exploded\n' });
    return Promise.resolve({ stdout: '', stderr: '' });
  }
}

class Harness {
  readonly runtime = new FakeRuntime();
  readonly reporter = new FakeReporter();
  available = true;
  readonly coordinator = new AgentContainerLaunchCoordinator(
    this.runtime,
    new IdempotentRetry(() => Promise.resolve()),
    new SullaFilesBindPlanner({ check: () => Promise.resolve(this.available
      ? { available: true }
      : { available: false, reason: 'ENOTCONN' }) }),
    this.reporter,
  );

  spec(): ContainerSpec { return { name: 'sulla-agent-job-1-0', image: 'agent:latest', autoRemove: true } }
}

describe('AgentContainerLaunchCoordinator', () => {
  it('creates without Docker auto-remove and explicitly removes a healthy run', async() => {
    // risk: diagnostics disappear before the real start error can be read
    const h = new Harness();
    const id = await h.coordinator.create(h.spec());
    await h.coordinator.removeNormal(id);
    expect(h.runtime.created[0].autoRemove).toBe(false);
    expect(h.runtime.removed).toEqual(['container-1']);
  });

  it('keeps, stops, collision-renames and records the final 200 log lines on failure', async() => {
    // risk: failed containers or their only useful evidence are lost
    const h = new Harness(); h.runtime.renameConflicts = 1;
    const record = await h.coordinator.retainFailure('container-1', 'sulla-agent-job-1-0', new Error('mount failed'));
    expect(h.runtime.removed).toEqual([]);
    expect(h.runtime.stopped).toEqual(['container-1']);
    expect(record.name).toBe('sulla-agent-job-1-0-failed-1');
    expect(h.reporter.failures[0]).toContain('Failure: mount failed');
    expect(h.reporter.failures[0]).toContain('tail=200');
  });

  it('records stderr-only Docker logs through the real guest runtime command path', async() => {
    // risk: startup failures written only to stderr disappear from the retained job check-in
    const executor = new StderrOnlyDockerExecutor();
    const reporter = new FakeReporter();
    const runtime = new GuestDockerRuntimeDriver(executor);
    const coordinator = new AgentContainerLaunchCoordinator(
      runtime, new IdempotentRetry(() => Promise.resolve()),
      new SullaFilesBindPlanner({ check: () => Promise.resolve({ available: true }) }), reporter,
    );
    await coordinator.retainFailure('container-1', 'sulla-agent-job-1-0', new Error('start failed'));
    expect(executor.commands).toContainEqual([
      'sh', '-c', 'docker logs --tail "$1" "$2" 2>&1', 'sulla-docker-logs', '200', 'container-1',
    ]);
    expect(reporter.failures[0]).toContain('fatal: startup exploded');
  });

  it('reports the first start error end-to-end instead of the later missing container symptom', async() => {
    // risk: operators see only misleading retry fallout
    const h = new Harness();
    h.runtime.startErrors = [new Error('invalid mount: transport endpoint is not connected'), new Error('No such container')];
    const failure = await h.coordinator.start('container-1', [0, 0]).catch(error => error);
    expect(failure).toBeInstanceOf(StartupRetryError);
    expect(failure.message).toContain('container exited during start and was removed: invalid mount');
    expect(failure.message).toContain('attempt 2: No such container');
  });

  it('launches without the Files bind, sets availability env and records a warning when Files is down', async() => {
    // risk: a stale mount flag makes every hidden agent fail to start
    const h = new Harness(); h.available = false;
    const plan = await h.coordinator.filesPlan();
    expect(plan.binds).toEqual([]);
    expect(plan.env).toMatchObject({ SULLA_FILES_AVAILABLE: '0', SULLA_FILES_UNAVAILABLE_REASON: 'ENOTCONN' });
    expect(h.reporter.warnings).toEqual(['Sulla Files unavailable for this run']);
  });

  it('includes the healthy Files bind and no warning when the probe succeeds', async() => {
    const h = new Harness();
    const plan = await h.coordinator.filesPlan();
    expect(plan.binds).toEqual(['/mnt/sulla-files:/mnt/sulla-files:rslave']);
    expect(plan.env.SULLA_FILES_AVAILABLE).toBe('1');
    expect(h.reporter.warnings).toEqual([]);
  });
});
