// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentJobRepository } from '../../../app/Repositories/AgentJobRepository';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('AgentJobRepository', () => {
  const database = new TestDatabase();
  let queryCount = 0;
  let repository: AgentJobRepository;

  beforeAll(async() => {
    await database.initialize();
    const connection = new PostgresConnection({ query: async(sql, bindings) => {
      queryCount += 1;
      const rows = await database.query(sql, [...(bindings ?? [])]);
      return { rows, rowCount: rows.length };
    } });
    repository = new AgentJobRepository(connection);
  }, 60_000);
  afterAll(async() => database.dispose());

  const job = (jobId: string, createdAt = Date.now()): AgentJob => ({
    jobId, status: 'running', createdAt, finishedAt: null, taskCount: 1, results: [],
    tasks: [{ agentId: 'worker', label: 'lane', prompt: 'work', status: 'running' }],
    visibility: 'hidden', completionDeliveredAt: null, dismissedAt: null,
  });

  it('round-trips rows and persists status transitions', async() => {
    // risk: durable job lifecycle state
    const input = job('repository-round-trip');
    await repository.insertJob(input);
    const hydrated = await repository.job(input.jobId);
    expect(hydrated).toMatchObject({ jobId: input.jobId, status: 'running', taskCount: 1 });
    hydrated!.status = 'completed';
    hydrated!.finishedAt = Date.now();
    await repository.complete(hydrated!);
    expect((await repository.job(input.jobId))?.status).toBe('completed');
  });

  it('never overwrites a stopped row with a later failure or completion', async() => {
    // risk: container teardown resurrects an intentional human kill as a failure
    const input = job('repository-terminal-stop-guard');
    await repository.insertJob(input);
    await repository.stop(input.jobId, input.tasks.map(task => ({ ...task, status: 'stopped' })), 'human', 'Killed by human');
    await repository.fail(input.jobId, 'Agent container disappeared', input.tasks.map(task => ({ ...task, status: 'error' })));
    await repository.complete({ ...input, status: 'failed', error: 'missing contract' });
    expect(await repository.job(input.jobId)).toMatchObject({ status: 'stopped', stoppedBy: 'human', stopReason: 'Killed by human' });
  });

  it('uses one bounded projection for every active job plus only 25 finished jobs', async() => {
    // risk: BL-043 unbounded history and N+1 database traffic
    const now = Date.now();
    for (let index = 0; index < 30; index++) {
      const item = job(`bounded-finished-${ index }`, now + index);
      await repository.insertJob(item);
      item.status = 'completed';
      item.finishedAt = now + index;
      await repository.complete(item);
    }
    await repository.insertJob(job('bounded-active', now + 100));
    queryCount = 0;
    const listed = await repository.jobsForList(25, true);
    expect(queryCount).toBe(1);
    expect(listed.filter(item => ['running', 'parked'].includes(item.status)).map(item => item.jobId)).toContain('bounded-active');
    expect(listed.filter(item => !['running', 'parked'].includes(item.status))).toHaveLength(25);
  });

  it('detects queued or running children across multiple task threads', async() => {
    // risk: agent job retention must not delete a parent with active children
    const runningThreadId = 'repository-child-running-thread';
    const completedThreadId = 'repository-child-completed-thread';
    const unrelatedThreadId = 'repository-child-unrelated-thread';
    const child = (jobId: string, parentThreadId: string): AgentJob => ({
      ...job(jobId), parentThreadId,
    });
    const runningChild = child('repository-child-running', runningThreadId);
    const completedChild = child('repository-child-completed', completedThreadId);
    const unrelatedChild = child('repository-child-unrelated', unrelatedThreadId);
    await repository.insertJob(runningChild);
    await repository.insertJob(completedChild);
    completedChild.status = 'completed';
    completedChild.tasks = completedChild.tasks.map(task => ({ ...task, status: 'completed' }));
    await repository.complete(completedChild);
    await repository.insertJob(unrelatedChild);

    const parent: AgentJob = {
      ...job('repository-parent-with-children'),
      tasks: [
        { agentId: 'worker', label: 'running', prompt: 'work', status: 'completed', threadId: completedThreadId },
        { agentId: 'worker', label: 'running', prompt: 'work', status: 'completed', threadId: runningThreadId },
      ],
    };
    expect(await repository.hasQueuedOrRunningChildren(parent)).toBe(true);

    const completedParent: AgentJob = {
      ...parent,
      tasks: parent.tasks.map(task => ({ ...task, threadId: completedThreadId })),
    };
    expect(await repository.hasQueuedOrRunningChildren(completedParent)).toBe(false);
  });
});
