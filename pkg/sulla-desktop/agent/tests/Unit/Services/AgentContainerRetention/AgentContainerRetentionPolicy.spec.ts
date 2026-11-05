// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import {
  ContainerRetentionPolicy, RetentionConfig,
  type ActiveContainerGuard, type Clock, type DiskSpaceProbe,
} from '@pkg/agent/services/AgentContainerRetentionPolicy';
import type { ContainerRuntimeDriver, ContainerSpec } from '@pkg/runtime/containerRuntime';

interface FixtureContainer {
  id:         string;
  name:       string;
  labels:     Record<string, string>;
  status:     string;
  createdAt:  string;
  finishedAt?: string;
}

const ZERO_TIME = '0001-01-01T00:00:00Z';

function agentContainer(overrides: Partial<FixtureContainer> & { id: string }): FixtureContainer {
  return {
    name:      overrides.id,
    labels:    { 'com.sulla.workload': 'agent' },
    status:    'exited',
    createdAt: new Date(0).toISOString(),
    finishedAt: ZERO_TIME,
    ...overrides,
  };
}

/** Fakes the real driver's two-step shape: `list()` returns thin entries, `inspect()` the full Docker JSON. */
class FakeContainerRuntimeDriver implements ContainerRuntimeDriver {
  private readonly containers = new Map<string, FixtureContainer>();
  readonly removedIds: string[] = [];
  readonly removeForceFlags: Array<boolean | undefined> = [];
  listError: Error | null = null;
  /** Label filters whose listing fails, so one pass can fail while the other succeeds. */
  failingListLabels = new Set<string>();
  inspectErrorIds = new Set<string>();
  removeErrorIds = new Set<string>();
  onInspect?: (id: string, call: number) => void;
  private inspectCalls = 0;
  /** When true, `list()` ignores the label filter — simulates a driver whose `ps --filter` can't be trusted. */
  ignoreListFilter = false;

  add(container: FixtureContainer): void { this.containers.set(container.id, container); }
  get(id: string): FixtureContainer | undefined { return this.containers.get(id); }

  async create(_spec: ContainerSpec): Promise<string> { throw new Error('not used in this fake') }
  async start(_id: string): Promise<void> { throw new Error('not used in this fake') }

  async list(label?: string): Promise<any[]> {
    if (this.listError) throw this.listError;
    if (label && this.failingListLabels.has(label)) throw new Error(`docker ps --filter label=${ label } failed`);
    const [key, value] = (label ?? '').split('=');
    return [...this.containers.values()]
      .filter(c => this.ignoreListFilter || !label || c.labels[key] === value)
      .map(c => ({ ID: c.id, Names: c.name }));
  }

  async inspect(id: string): Promise<any> {
    this.inspectCalls += 1;
    this.onInspect?.(id, this.inspectCalls);
    if (this.inspectErrorIds.has(id)) throw new Error(`inspect failed for ${ id }`);
    const container = this.containers.get(id);
    if (!container) throw new Error(`no such container: ${ id }`);
    return {
      Id:     container.id,
      Name:   `/${ container.name }`,
      Created: container.createdAt,
      State:   { Status: container.status, FinishedAt: container.finishedAt ?? ZERO_TIME },
      Config:  { Labels: container.labels },
    };
  }

  async remove(id: string, force?: boolean): Promise<void> {
    this.removeForceFlags.push(force);
    if (this.removeErrorIds.has(id)) throw new Error(`remove failed for ${ id }`);
    this.containers.delete(id);
    this.removedIds.push(id);
  }
}

class FakeClock implements Clock {
  constructor(public current = 10_000_000) {}
  now(): number { return this.current; }
}

class FakeDiskSpaceProbe implements DiskSpaceProbe {
  calls = 0;
  throwOnCall: number | null = null;
  constructor(private readonly sequence: number[]) {}
  async freeBytes(): Promise<number> {
    this.calls += 1;
    if (this.throwOnCall === this.calls) throw new Error('df failed');
    const index = Math.min(this.calls - 1, this.sequence.length - 1);
    return this.sequence[index];
  }
}

class FakeActiveContainerGuard implements ActiveContainerGuard {
  readonly activeIds = new Set<string>();
  isActive(containerId: string): boolean { return this.activeIds.has(containerId); }
}

const HOUR_MS = 60 * 60 * 1_000;

function buildPolicy(options: {
  runtime?: FakeContainerRuntimeDriver;
  disk?: DiskSpaceProbe;
  clock?: Clock;
  guard?: ActiveContainerGuard;
  config?: RetentionConfig;
} = {}) {
  const runtime = options.runtime ?? new FakeContainerRuntimeDriver();
  const disk = options.disk ?? new FakeDiskSpaceProbe([100 * 1024 ** 3]);
  const clock = options.clock ?? new FakeClock();
  const guard = options.guard ?? new FakeActiveContainerGuard();
  const config = options.config ?? new RetentionConfig();
  const policy = new ContainerRetentionPolicy(runtime, disk, clock, guard, config);
  return { runtime, disk, clock, guard, config, policy };
}

describe('ContainerRetentionPolicy', () => {
  it('returns a list-stage error without removing anything when list fails', async() => {
    // risk: a Docker listing failure aborts retention without an observable job-level error
    const runtime = new FakeContainerRuntimeDriver();
    runtime.listError = new Error('docker ps failed');
    const { policy } = buildPolicy({ runtime });

    const report = await policy.enforce();

    expect(report.errors).toEqual([
      { stage: 'agent-owner-list', message: 'docker ps failed' },
      { stage: 'list', message: 'docker ps failed' },
    ]);
    expect(report.removed).toEqual([]);
    expect(report.keptCount).toBe(0);
    expect(runtime.removedIds).toEqual([]);
  });

  it('records a first disk probe failure while preserving age and count removals', async() => {
    // risk: a df failure hides retention errors or prevents age/count cleanup that protects disk
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({ id: 'old', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString() }));
    runtime.add(agentContainer({ id: 'older-kept', finishedAt: new Date(clock.current - 2 * HOUR_MS).toISOString() }));
    runtime.add(agentContainer({ id: 'newest', finishedAt: new Date(clock.current - 1 * HOUR_MS).toISOString() }));
    const disk = new FakeDiskSpaceProbe([100 * 1024 ** 3]);
    disk.throwOnCall = 1;
    const { policy } = buildPolicy({
      runtime, clock, disk,
      config: new RetentionConfig({ maxAgeMs: 24 * HOUR_MS, maxKept: 1 }),
    });

    const report = await policy.enforce();

    expect(report.removed).toEqual([
      { id: 'old', name: 'old', reason: 'age' },
      { id: 'older-kept', name: 'older-kept', reason: 'count' },
    ]);
    expect(report.freeBytesBefore).toBeNull();
    expect(report.freeBytesAfter).toBeNull();
    expect(report.errors).toEqual([{ stage: 'disk-probe', message: 'df failed' }]);
    expect(report.keptCount).toBe(1);
    expect(runtime.get('newest')).toBeDefined();
  });

  it('removes a finished container older than maxAgeMs', async() => {
    // risk: a disk-filling pile of finished containers never clears because nothing enforces an age ceiling
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({
      id: 'old', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString(),
    }));
    const { policy } = buildPolicy({ runtime, clock, config: new RetentionConfig({ maxAgeMs: 24 * HOUR_MS }) });

    const report = await policy.enforce();

    expect(report.removed).toEqual([{ id: 'old', name: 'old', reason: 'age' }]);
    expect(runtime.get('old')).toBeUndefined();
  });

  it('keeps the newest 10 of 50 finished containers under the count cap', async() => {
    // risk: an unbounded pile of failed containers exhausts guest disk even with no single container past maxAgeMs
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    for (let i = 0; i < 50; i++) {
      runtime.add(agentContainer({
        id: `c${ i }`, finishedAt: new Date(clock.current - (50 - i) * 1_000).toISOString(),
      }));
    }
    const { policy } = buildPolicy({
      runtime, clock,
      config: new RetentionConfig({ maxAgeMs: 10 * HOUR_MS, maxKept: 10, createdGraceMs: 0 }),
    });

    const report = await policy.enforce();

    expect(report.removed).toHaveLength(40);
    expect(report.removed.every(entry => entry.reason === 'count')).toBe(true);
    const keptIds = new Set(Array.from({ length: 50 }, (_, i) => `c${ i }`).filter(id => runtime.get(id)));
    expect(keptIds.size).toBe(10);
    // c40..c49 are the 10 newest (smallest age offset); everything older was removed first.
    for (let i = 40; i < 50; i++) expect(keptIds.has(`c${ i }`)).toBe(true);
  });

  it('sheds the oldest containers until disk space clears the threshold, re-probing after each removal', async() => {
    // risk: the VM disk fills to 99% (2026-11-04 incident) and nothing frees space before the next agent launch fails
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    for (let i = 0; i < 5; i++) {
      runtime.add(agentContainer({
        id: `d${ i }`, finishedAt: new Date(clock.current - (5 - i) * 1_000).toISOString(),
      }));
    }
    const minFreeDiskBytes = 5 * 1024 ** 3;
    // Starts below threshold; each removal frees 2 GiB until the 3rd removal clears it.
    const disk = new FakeDiskSpaceProbe([
      4 * 1024 ** 3, 4.5 * 1024 ** 3, 4.9 * 1024 ** 3, 5.2 * 1024 ** 3,
    ]);
    const { policy } = buildPolicy({
      runtime, clock, disk,
      config: new RetentionConfig({ maxAgeMs: 10 * HOUR_MS, maxKept: 50, minFreeDiskBytes, createdGraceMs: 0 }),
    });

    const report = await policy.enforce();

    expect(report.removed.map(entry => entry.id)).toEqual(['d0', 'd1', 'd2']);
    expect(report.removed.every(entry => entry.reason === 'disk')).toBe(true);
    expect(report.freeBytesBefore).toBe(4 * 1024 ** 3);
    expect(report.freeBytesAfter).toBe(5.2 * 1024 ** 3);
    expect(runtime.get('d3')).toBeDefined();
    expect(runtime.get('d4')).toBeDefined();
  });

  it('never removes a running container no matter how old', async() => {
    // risk: retention kills a container an agent is actively using
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({
      id: 'alive', status: 'running', createdAt: new Date(clock.current - 48 * HOUR_MS).toISOString(), finishedAt: ZERO_TIME,
    }));
    const { policy } = buildPolicy({ runtime, clock, config: new RetentionConfig({ maxAgeMs: 1 * HOUR_MS, maxKept: 0 }) });

    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(runtime.get('alive')).toBeDefined();
  });

  it('never removes a non-agent container even when the driver returns it from list()', async() => {
    // risk: a lenient or buggy driver list() hands back sulla_files_fuse/postgres and retention deletes shared infra
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.ignoreListFilter = true;
    runtime.add(agentContainer({
      id: 'fuse', name: 'sulla_files_fuse', labels: {}, createdAt: new Date(clock.current - 48 * HOUR_MS).toISOString(),
      finishedAt: new Date(clock.current - 48 * HOUR_MS).toISOString(),
    }));
    runtime.add(agentContainer({
      id: 'pg', name: 'postgres', labels: { 'com.sulla.workload': 'database' },
      createdAt: new Date(clock.current - 48 * HOUR_MS).toISOString(), finishedAt: new Date(clock.current - 48 * HOUR_MS).toISOString(),
    }));
    const { policy } = buildPolicy({ runtime, clock, config: new RetentionConfig({ maxAgeMs: 1 * HOUR_MS, maxKept: 0 }) });

    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(runtime.get('fuse')).toBeDefined();
    expect(runtime.get('pg')).toBeDefined();
    expect(report.keptCount).toBe(0);
  });

  it('never removes a container the active-launch guard reports as active', async() => {
    // risk: retention races a just-launched container and kills it mid-startup
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({
      id: 'launching', createdAt: new Date(clock.current - 48 * HOUR_MS).toISOString(),
      finishedAt: new Date(clock.current - 48 * HOUR_MS).toISOString(),
    }));
    const guard = new FakeActiveContainerGuard();
    guard.activeIds.add('launching');
    const { policy } = buildPolicy({ runtime, clock, guard, config: new RetentionConfig({ maxAgeMs: 1 * HOUR_MS, maxKept: 0 }) });

    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(runtime.get('launching')).toBeDefined();
  });

  it('keeps a young `created` container inside its startup grace window', async() => {
    // risk: retention removes a container mid-`docker create`/`start` race before it ever ran
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({
      id: 'starting', status: 'created', createdAt: new Date(clock.current - 2 * 60 * 1_000).toISOString(), finishedAt: ZERO_TIME,
    }));
    const { policy } = buildPolicy({
      runtime, clock, config: new RetentionConfig({ maxAgeMs: 0, maxKept: 0, createdGraceMs: 10 * 60 * 1_000 }),
    });

    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(runtime.get('starting')).toBeDefined();
  });

  it('removes a stale `created` container once it is past the grace window', async() => {
    // risk: a container stuck at `created` (never started) after a failed launch piles up forever if grace never expires
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({
      id: 'stuck', status: 'created', createdAt: new Date(clock.current - 20 * 60 * 1_000).toISOString(), finishedAt: ZERO_TIME,
    }));
    const { policy } = buildPolicy({
      runtime, clock, config: new RetentionConfig({ maxAgeMs: 0, maxKept: 0, createdGraceMs: 10 * 60 * 1_000 }),
    });

    const report = await policy.enforce();

    expect(report.removed).toEqual([{ id: 'stuck', name: 'stuck', reason: 'age' }]);
  });

  it('collects a remove() failure as an error and still removes the rest', async() => {
    // risk: one container that refuses removal (e.g. a race with Docker) silently aborts the whole retention pass
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({ id: 'stuck', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString() }));
    runtime.add(agentContainer({ id: 'removable', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString() }));
    runtime.removeErrorIds.add('stuck');
    const { policy } = buildPolicy({ runtime, clock, config: new RetentionConfig({ maxAgeMs: 24 * HOUR_MS }) });

    const report = await policy.enforce();

    expect(report.removed).toEqual([{ id: 'removable', name: 'removable', reason: 'age' }]);
    expect(report.errors).toEqual([{ stage: 'remove', id: 'stuck', message: 'remove failed for stuck' }]);
    expect(runtime.get('stuck')).toBeDefined();
  });

  it('collects an inspect() failure as an error without aborting the run', async() => {
    // risk: one unreadable container (e.g. a guest docker hiccup) stops retention from protecting disk space at all
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({ id: 'broken', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString() }));
    runtime.add(agentContainer({ id: 'fine', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString() }));
    runtime.inspectErrorIds.add('broken');
    const { policy } = buildPolicy({ runtime, clock, config: new RetentionConfig({ maxAgeMs: 24 * HOUR_MS }) });

    const report = await policy.enforce();

    expect(report.removed).toEqual([{ id: 'fine', name: 'fine', reason: 'age' }]);
    expect(report.errors).toEqual([{ stage: 'inspect', id: 'broken', message: 'inspect failed for broken' }]);
  });

  it('removes with force=false since every candidate already passed the running/paused/restarting guard', async() => {
    // risk: a forced removal could kill a container that started running in the race between inspect and remove
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({ id: 'old', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString() }));
    const { policy } = buildPolicy({ runtime, clock, config: new RetentionConfig({ maxAgeMs: 24 * HOUR_MS }) });

    await policy.enforce();

    expect(runtime.removeForceFlags).toEqual([false]);
  });
  it('reaps expired terminal agent containers while preserving live, parked, young unknown, persistent, and unrelated containers', async() => {
    // risk: expiry kills a live worker or parked manager, or an unknown young owner is mistaken for an orphan
    const clock = new FakeClock(20_000_000);
    const runtime = new FakeContainerRuntimeDriver();
    const expires = Math.floor(clock.current / 1_000);
    const old = new Date(clock.current - 25 * HOUR_MS).toISOString();
    runtime.add(agentContainer({ id: 'expired-live', createdAt: old, labels: { 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'live', 'com.sulla.expires-at': String(expires - 1), 'com.sulla.persistent': 'false' } }));
    runtime.add(agentContainer({ id: 'expired-parked', createdAt: old, labels: { 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'parked', 'com.sulla.expires-at': String(expires - 1), 'com.sulla.persistent': 'false' } }));
    runtime.add(agentContainer({ id: 'expired-unknown-young', createdAt: new Date(clock.current - HOUR_MS).toISOString(), labels: { 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'missing', 'com.sulla.expires-at': String(expires - 1), 'com.sulla.persistent': 'false' } }));
    runtime.add(agentContainer({ id: 'expired-terminal', createdAt: old, labels: { 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'done', 'com.sulla.expires-at': String(expires - 1), 'com.sulla.persistent': 'false' } }));
    runtime.add(agentContainer({ id: 'terminal', createdAt: old, labels: { 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'done', 'com.sulla.expires-at': String(expires + 1000), 'com.sulla.persistent': 'false' } }));
    runtime.add(agentContainer({ id: 'persistent', status: 'running', labels: { 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'done', 'com.sulla.expires-at': String(expires + 1000), 'com.sulla.persistent': 'true' } }));
    runtime.add(agentContainer({ id: 'postgres', labels: {}, status: 'running' }));
    const policy = new ContainerRetentionPolicy(runtime, new FakeDiskSpaceProbe([100 * 1024 ** 3]), clock, new FakeActiveContainerGuard(), new RetentionConfig(), {
      status: async(jobId: string) => ({ done: 'completed', live: 'running', parked: 'parked' } as Record<string, string>)[jobId],
    });
    const report = await policy.enforce();
    expect(report.removed.map(entry => [entry.id, entry.reason])).toEqual([['expired-terminal', 'expired'], ['terminal', 'terminal-owner']]);
    expect(runtime.get('expired-live')).toBeDefined();
    expect(runtime.get('expired-parked')).toBeDefined();
    expect(runtime.get('expired-unknown-young')).toBeDefined();
    expect(runtime.get('persistent')).toBeDefined();
    expect(runtime.get('postgres')).toBeDefined();
  });

  it('does not pressure-reap a live owner and rechecks a job that starts after inspection', async() => {
    // risk: disk pressure or an inspect/remove race kills a live agent
    const clock = new FakeClock(30 * HOUR_MS);
    const runtime = new FakeContainerRuntimeDriver();
    const labels = { 'com.sulla.owner': 'agent', 'com.sulla.expires-at': String(clock.current / 1_000 + 1000), 'com.sulla.persistent': 'false' };
    runtime.add(agentContainer({ id: 'pressure-live', createdAt: new Date(0).toISOString(), labels: { ...labels, 'com.sulla.job-id': 'live' } }));
    runtime.add(agentContainer({ id: 'race', createdAt: new Date(0).toISOString(), labels: { ...labels, 'com.sulla.job-id': 'race' } }));
    let raceReads = 0;
    const policy = new ContainerRetentionPolicy(runtime, new FakeDiskSpaceProbe([0, 0, 100 * 1024 ** 3]), clock, new FakeActiveContainerGuard(), new RetentionConfig(), {
      status: async jobId => jobId === 'live' ? 'running' : (++raceReads === 1 ? 'completed' : 'running'),
    });

    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(runtime.get('pressure-live')).toBeDefined();
    expect(runtime.get('race')).toBeDefined();
  });

  it('keeps an expired container registered as an active launch', async() => {
    // risk: a job record can lag while the launch registry already knows the container is active
    const clock = new FakeClock(30 * HOUR_MS);
    const runtime = new FakeContainerRuntimeDriver();
    runtime.add(agentContainer({ id: 'launching', createdAt: new Date(0).toISOString(), labels: { 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'done', 'com.sulla.expires-at': '1', 'com.sulla.persistent': 'false' } }));
    const guard = new FakeActiveContainerGuard();
    guard.activeIds.add('launching');
    const policy = new ContainerRetentionPolicy(runtime, new FakeDiskSpaceProbe([100 * 1024 ** 3]), clock, guard, new RetentionConfig(), { status: async() => 'completed' });

    expect((await policy.enforce()).removed).toEqual([]);
    expect(runtime.get('launching')).toBeDefined();
  });

  it('still enforces failed-container retention when the agent-owner listing fails', async() => {
    // risk: one broken temporary-container listing silently disables the age/count/disk cleanup of failed containers
    const clock = new FakeClock();
    const runtime = new FakeContainerRuntimeDriver();
    runtime.failingListLabels.add('com.sulla.owner=agent');
    runtime.add(agentContainer({ id: 'old-failed', finishedAt: new Date(clock.current - 25 * HOUR_MS).toISOString() }));
    const { policy } = buildPolicy({ runtime, clock, config: new RetentionConfig({ maxAgeMs: 24 * HOUR_MS }) });

    const report = await policy.enforce();

    expect(report.errors).toEqual([{ stage: 'agent-owner-list', message: 'docker ps --filter label=com.sulla.owner=agent failed' }]);
    expect(report.removed).toEqual([{ id: 'old-failed', name: 'old-failed', reason: 'age' }]);
    expect(runtime.get('old-failed')).toBeUndefined();
  });
});
