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

  async findInlineReview(parentThreadId: string, task: AgentJobTask): Promise<AgentJob | undefined> {
    return this.jobs.find(job => job.parentThreadId === parentThreadId && ['running', 'parked', 'completed'].includes(job.status)
      && job.tasks.length === 1 && job.tasks[0].inlineReviewDigest === task.inlineReviewDigest
      && job.tasks[0].agentId === task.agentId && job.tasks[0].followUpOf?.jobId === task.followUpOf?.jobId
      && job.tasks[0].followUpOf?.taskIndex === task.followUpOf?.taskIndex
      && job.tasks[0].workerModelRoute?.agentId === task.workerModelRoute?.agentId
      && job.tasks[0].workerModelRoute?.revision === task.workerModelRoute?.revision
      && (job.tasks[0].workerModelRoute?.editToken ?? '') === (task.workerModelRoute?.editToken ?? ''));
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

  it('reuses the same inline review across labels, concurrent calls and completed-job reload', async() => {
    const h = new SpawnCreatorHarness();
    const source = { inlineReviewDigest: 'same-bytes', workflowStep: 'review' as const, followUpOf: { jobId: 'impl', taskIndex: 1 } };
    const review = (label: string, patch: Partial<AgentJobTask> = {}) =>
      h.creator.create([{ ...task(label), ...source, ...patch }], 'manager', 'parent-a', { parentAgentId: 'manager', dedupeLabel: label });
    const [first, duplicate] = await Promise.all([review('review'), review('better wording')]);
    expect(duplicate.jobId).toBe(first.jobId);
    first.status = 'completed';
    h.runtime.reset();
    h.clock.nowMs += 120_000;
    expect((await review('rereview')).jobId).toBe(first.jobId);
    expect((await review('new artifact', { inlineReviewDigest: 'changed-bytes' })).jobId).not.toBe(first.jobId);
    first.status = 'failed';
    expect((await review('retry failed')).jobId).not.toBe(first.jobId);
  });

  it('starts a new inline review after each saved reviewer selection and reuses an unchanged one', async() => {
    const h = new SpawnCreatorHarness();
    const source = { inlineReviewDigest: 'same-bytes', workflowStep: 'review' as const, followUpOf: { jobId: 'impl', taskIndex: 1 } };
    // Each Workflow save writes revision 1 again; only the edit token tells two saves apart.
    const route = (editToken: string) => ({ version: 1 as const, slug: 'worker', agentId: 'def-worker', revision: 1, editToken, selected: 0, candidates: [{ provider: 'codex', model: 'gpt-sol' }] });
    const review = (label: string, editToken: string) =>
      h.creator.create([{ ...task(label), ...source, workerModelRoute: route(editToken) }], 'manager', 'parent-a', { parentAgentId: 'manager', dedupeLabel: label });

    const first = await review('review', 'save-1');
    first.status = 'completed';
    const [afterSecondSave, concurrentSecondSave] = await Promise.all([review('review', 'save-2'), review('review again', 'save-2')]);
    expect(afterSecondSave.jobId).not.toBe(first.jobId); // risk: the earlier reviewer's result answers a changed selection
    expect(concurrentSecondSave.jobId).toBe(afterSecondSave.jobId);

    h.runtime.reset();
    h.clock.nowMs += 120_000;
    const unchanged = await review('retry', 'save-2');
    expect(unchanged.jobId).toBe(afterSecondSave.jobId);
    expect(unchanged.deduplicated).toBe(true);
    expect((await review('retry first', 'save-1')).jobId).toBe(first.jobId);
    expect(h.repository.jobs).toHaveLength(2);
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
