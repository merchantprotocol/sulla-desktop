// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { JobIdGenerator } from '../../../app/Services/JobIdGenerator';
import { JobRuntimeRegistry } from '../../../app/Services/JobRuntimeRegistry';
import { SpawnDedupeGuard } from '../../../app/Services/SpawnDedupeGuard';
import { SpawnJobCreator, type SpawnJobRepository } from '../../../app/Services/SpawnJobCreator';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

class TestClock {
  constructor(public nowMs: number) {}
  now(): Date { return new Date(this.nowMs); }
}

class InMemorySpawnJobRepository implements SpawnJobRepository {
  readonly jobs: AgentJob[] = [];

  async insertJob(job: AgentJob): Promise<void> {
    await Promise.resolve();
    this.jobs.push(job);
  }

  async recentSpawnJob(parentThreadId: string | undefined, parentAgentId: string | undefined, label: string, since: number): Promise<AgentJob | undefined> {
    return [...this.jobs].reverse().find(job =>
      job.tasks.length === 1 && job.tasks[0].label === label && job.createdAt >= since && job.status !== 'stopped' &&
      (parentThreadId ? job.parentThreadId === parentThreadId : !job.parentThreadId && job.parentAgentId === parentAgentId));
  }
}

const task = (label: string): AgentJobTask => ({ agentId: 'worker', label, prompt: 'work', status: 'queued' });

class SpawnCreatorHarness {
  readonly repository = new InMemorySpawnJobRepository();
  readonly runtime = new JobRuntimeRegistry();
  readonly guard: SpawnDedupeGuard;
  readonly creator: SpawnJobCreator;

  constructor(readonly clock = new TestClock(100_000)) {
    this.guard = new SpawnDedupeGuard(clock as any);
    this.creator = new SpawnJobCreator(
      this.repository, this.runtime, { ensureHydrated: async() => {} } as any,
      clock as any, new JobIdGenerator(clock as any), this.guard, { create: async(job) => { await this.repository.insertJob(job); this.runtime.jobs.set(job.jobId, job); } },
    );
  }

  create(label: string | undefined, parentThreadId = 'parent-a', parentAgentId = 'manager') {
    return this.creator.create([task(label ?? 'implicit')], 'manager', parentThreadId, { parentAgentId, dedupeLabel: label });
  }
}

describe('SpawnJobCreator idempotency', () => {
  it('atomically reuses one job for real concurrent create calls', async() => {
    const harness = new SpawnCreatorHarness();
    const [first, second] = await Promise.all([harness.create('same'), harness.create('same')]);
    expect(second.jobId).toBe(first.jobId); // risk: duplicate worker execution
    expect(second.deduplicated).toBe(true);
    expect(harness.repository.jobs).toHaveLength(1);
  });

  it('isolates parent identity and opts out when the explicit label is absent', async() => {
    const harness = new SpawnCreatorHarness();
    const first = await harness.create('same', 'parent-a');
    const otherParent = await harness.create('same', 'parent-b');
    const noLabelOne = await harness.create(undefined, 'parent-a');
    const noLabelTwo = await harness.create(undefined, 'parent-a');
    expect(otherParent.jobId).not.toBe(first.jobId); // risk: cross-parent custody
    expect(noLabelTwo.jobId).not.toBe(noLabelOne.jobId); // risk: accidental implicit-label reuse
  });

  it('reuses at 29.999 seconds and creates at the exact 30 second boundary', async() => {
    const harness = new SpawnCreatorHarness();
    const first = await harness.create('boundary');
    harness.runtime.reset();
    harness.clock.nowMs += 29_999;
    expect((await harness.create('boundary')).jobId).toBe(first.jobId); // risk: retry window accuracy
    harness.runtime.reset();
    harness.clock.nowMs += 1;
    expect((await harness.create('boundary')).jobId).not.toBe(first.jobId);
  });

  it('does not reuse a multi-task batch or a stopped row', async() => {
    const harness = new SpawnCreatorHarness();
    const batch = await harness.creator.create([task('target'), task('other')], 'manager', 'parent-a', { parentAgentId: 'manager' });
    harness.runtime.reset();
    const single = await harness.create('target');
    expect(single.jobId).not.toBe(batch.jobId); // risk: partial batch reuse
    single.status = 'stopped';
    harness.runtime.reset();
    expect((await harness.create('target')).jobId).not.toBe(single.jobId); // risk: stopped-job resurrection
  });
});
