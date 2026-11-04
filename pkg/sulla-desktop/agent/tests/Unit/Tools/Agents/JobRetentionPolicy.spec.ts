// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { JobRetentionPolicy, type JobRetentionRepository } from '../../../../tools/agents/JobRetentionPolicy';
import type { AgentJob } from '../../../../tools/agents/jobRegistry';

class RetentionRepositoryFixture implements JobRetentionRepository {
  readonly deleteJob = vi.fn(async() => {});
  readonly hasQueuedOrRunningChildren = vi.fn(async() => false);
}

class FixedClock {
  constructor(private readonly time: number) {}
  now(): number { return this.time; }
}

class JobFixture {
  static finished(overrides: Partial<AgentJob> = {}): AgentJob {
    return {
      jobId: 'retention-job', status: 'completed', createdAt: 1, finishedAt: 1,
      taskCount: 1, results: [], completionDeliveredAt: 2,
      tasks: [{ agentId: 'worker', label: 'lane', prompt: 'work', status: 'completed', returnedAt: 2 }],
      ...overrides,
    };
  }
}

describe('JobRetentionPolicy', () => {
  const day = 24 * 60 * 60 * 1_000;

  it('keeps finished jobs younger than seven days', async() => {
    // risk: live operational evidence deleted too early
    const repository = new RetentionRepositoryFixture();
    const policy = new JobRetentionPolicy(new FixedClock(7 * day), repository);
    expect(await policy.prune(JobFixture.finished({ finishedAt: day }))).toBe(false);
    expect(repository.deleteJob).not.toHaveBeenCalled();
  });

  it('prunes a contract-returned job older than seven days', async() => {
    // risk: retention never releases genuinely settled history
    const repository = new RetentionRepositoryFixture();
    const policy = new JobRetentionPolicy(new FixedClock(8 * day + 1), repository);
    expect(await policy.prune(JobFixture.finished({ finishedAt: day }))).toBe(true);
    expect(repository.deleteJob).toHaveBeenCalledWith('retention-job');
  });

  it('keeps an old job while a child is queued or running', async() => {
    // risk: parked manager loses the workers that can wake it
    const repository = new RetentionRepositoryFixture();
    repository.hasQueuedOrRunningChildren.mockResolvedValue(true);
    const policy = new JobRetentionPolicy(new FixedClock(9 * day), repository);
    expect(await policy.prune(JobFixture.finished({ finishedAt: day }))).toBe(false);
    expect(repository.deleteJob).not.toHaveBeenCalled();
  });

  it('keeps an old completed job whose contract remains open', async() => {
    // risk: parent contract and future worker result become orphaned
    const repository = new RetentionRepositoryFixture();
    const policy = new JobRetentionPolicy(new FixedClock(9 * day), repository);
    const job = JobFixture.finished({
      finishedAt: day,
      tasks: [{ agentId: 'manager', label: 'manager', prompt: 'work', status: 'completed' }],
    });
    expect(await policy.prune(job)).toBe(false);
    expect(repository.deleteJob).not.toHaveBeenCalled();
  });
});
