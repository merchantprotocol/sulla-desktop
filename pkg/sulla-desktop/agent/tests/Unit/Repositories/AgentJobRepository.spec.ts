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

  it('allows only one concurrent reopen claim and preserves generation history', async() => {
    // risk: duplicate worker execution and loss of prior completion evidence
    const input = job('repository-reopen-cas');
    input.tasks[0] = { ...input.tasks[0], status: 'completed', generation: 1, result: { answer: 1 },
      completion: { label: 'lane', status: 'completed', output: 'first', threadId: 'thread-1' },
      returnedAt: Date.now(), finishedAt: Date.now(), completionDeliveredAt: Date.now() };
    input.results = [input.tasks[0].completion!];
    await repository.insertJob(input);
    await repository.complete({ ...input, status: 'completed', finishedAt: Date.now() });
    const claims = await Promise.all([repository.claimReopen(input.jobId, 0, 1), repository.claimReopen(input.jobId, 0, 1)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ generation: 2 });
    expect(await database.query(`SELECT generation, result, completion FROM agent_job_result_history WHERE job_id = $1`, [input.jobId]))
      .toEqual([expect.objectContaining({ generation: 1, result: { answer: 1 }, completion: expect.objectContaining({ output: 'first' }) })]);
  });

  it('loads only the requested thread lineage for the subagent directory', async() => {
    // risk: subagent recall latency and cross-thread data leakage — do not scan unrelated agent jobs
    const rootThread = 'preloop-lineage-root';
    const childThread = 'preloop-lineage-child';
    const direct = { ...job('preloop-lineage-direct'), parentThreadId: rootThread };
    direct.tasks[0] = { ...direct.tasks[0], threadId: childThread };
    const descendant = { ...job('preloop-lineage-descendant'), parentThreadId: childThread };
    const unrelated = { ...job('preloop-lineage-unrelated'), parentThreadId: 'another-thread' };
    await repository.insertJob(direct);
    await repository.insertJob(descendant);
    await repository.insertJob(unrelated);

    const rows = await repository.lineageForParentThread(rootThread, 100);
    expect(rows.map(row => row.jobId)).toEqual(expect.arrayContaining(['preloop-lineage-direct', 'preloop-lineage-descendant']));
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.jobId)).not.toContain(unrelated.jobId);
  });

  it('refuses reopen claims for stopped, failed, over-limit, and actively leased tasks', async() => {
    // risk: replaying terminal work or running two generations concurrently
    const createSettled = async(id: string, taskStatus: 'completed' | 'blocked' | 'error' | 'stopped', jobStatus: AgentJob['status']) => {
      const input = job(id);
      input.tasks[0] = { ...input.tasks[0], status: taskStatus, generation: 1 };
      await repository.insertJob(input);
      if (jobStatus === 'stopped') await repository.stop(id, input.tasks, 'human', 'stop');
      else if (jobStatus === 'failed') await repository.fail(id, 'failed', input.tasks);
      else await repository.complete({ ...input, status: jobStatus, finishedAt: Date.now() });
      return input;
    };
    const stopped = await createSettled('repository-reopen-stopped', 'stopped', 'stopped');
    const failed = await createSettled('repository-reopen-failed', 'error', 'failed');
    expect(await repository.claimReopen(stopped.jobId, 0, 1)).toBeUndefined();
    expect(await repository.claimReopen(failed.jobId, 0, 1)).toBeUndefined();
    const limited = await createSettled('repository-reopen-limited', 'completed', 'completed');
    await database.query(`INSERT INTO agent_job_task_reopens (job_id, task_index, generation, reopen_count) VALUES ($1, 0, 1, 5)`, [limited.jobId]);
    expect(await repository.claimReopen(limited.jobId, 0, 1)).toBeUndefined();
    const leased = await createSettled('repository-reopen-leased', 'blocked', 'completed');
    await database.query(`INSERT INTO agent_job_task_reopens (job_id, task_index, generation, reopen_count, lease_id, lease_acquired_at) VALUES ($1, 0, 1, 0, 'held', now())`, [leased.jobId]);
    expect(await repository.claimReopen(leased.jobId, 0, 1)).toBeUndefined();
  });

  it('records each generation in history while projecting the latest result', async() => {
    // risk: audit evidence loss when a reopened worker returns again
    const input = job('repository-generation-history');
    await repository.insertJob(input);
    const first = { label: 'lane', status: 'completed' as const, output: 'first', threadId: 'thread' };
    input.tasks[0] = { ...input.tasks[0], status: 'completed', generation: 1, completion: first };
    await repository.updateTaskCompletions(input.jobId, 0, input.tasks, [first]);
    const second = { ...first, output: 'second' };
    input.tasks[0] = { ...input.tasks[0], generation: 2, completion: second };
    await repository.updateTaskCompletions(input.jobId, 0, input.tasks, [second]);
    expect(await database.query(`SELECT generation, completion->>'output' AS output FROM agent_job_result_history WHERE job_id = $1 ORDER BY generation`, [input.jobId]))
      .toEqual([{ generation: 1, output: 'first' }, { generation: 2, output: 'second' }]);
    expect((await repository.job(input.jobId))?.results[0].output).toBe('second');
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
