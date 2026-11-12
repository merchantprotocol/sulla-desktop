// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentJobRepository } from '../../../app/Repositories/AgentJobRepository';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import { TestDatabase } from '../../Support/TestDatabase';
import { up as normalizeTasks } from '../../../database/migrations/0155_normalize_agent_job_tasks';

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

  it('backfills typed task ownership idempotently and projects ancestors without payload JSON', async() => {
    // risk: losing job/task ownership across migration restart or omitting a finished ancestor
    const base = Date.now();
    const child = { ...job('projection-child', base), parentThreadId: 'projection-root-thread', tasks: [
      { agentId: 'worker', label: 'active', prompt: 'synthetic', status: 'running' as const, threadId: 'projection-live-thread', visibility: 'tab' as const },
      { agentId: 'worker-2', label: 'queued', prompt: 'synthetic', status: 'queued' as const, threadId: 'projection-live-thread-2' },
    ] };
    // Child is written before its parent ownership row; parent insertion must repair the relation.
    await repository.insertJob(child);
    const ancestor = job('projection-ancestor', base - 3_000);
    ancestor.status = 'completed';
    ancestor.finishedAt = Date.now() - 60 * 60_000;
    ancestor.tasks[0] = { ...ancestor.tasks[0], status: 'completed', threadId: 'projection-root-thread', prompt: 'PRIVATE SYNTHETIC PAYLOAD' };
    await repository.insertJob(ancestor);
    await repository.complete({ ...ancestor, status: 'completed', finishedAt: Date.now() });
    await database.query(`UPDATE agent_jobs SET finished_at = now() - interval '1 hour' WHERE job_id = $1`, [ancestor.jobId]);
    const cycleA = { ...job('projection-cycle-a', base - 2_000), parentThreadId: 'projection-cycle-b-thread' };
    cycleA.tasks[0] = { ...cycleA.tasks[0], threadId: 'projection-cycle-a-thread' };
    const cycleB = { ...job('projection-cycle-b', base - 1_000), parentThreadId: 'projection-cycle-a-thread' };
    cycleB.tasks[0] = { ...cycleB.tasks[0], threadId: 'projection-cycle-b-thread' };
    await repository.insertJob(cycleA);
    await repository.insertJob(cycleB);
    await repository.complete({ ...cycleB, status: 'completed', finishedAt: Date.now() });
    await database.query(`UPDATE agent_jobs SET finished_at = now() - interval '1 hour' WHERE job_id = $1`, [cycleB.jobId]);
    const recentTerminal = job('projection-recent-terminal', base - 100);
    await repository.insertJob(recentTerminal);
    await repository.complete({ ...recentTerminal, status: 'completed', finishedAt: Date.now() });
    const expired = job('projection-expired-unrelated', base - 3_600_000);
    await repository.insertJob(expired);
    await repository.complete({ ...expired, status: 'completed', finishedAt: Date.now() - 3_600_000 });
    await database.query(`UPDATE agent_jobs SET finished_at = now() - interval '1 hour' WHERE job_id = $1`, [expired.jobId]);

    expect(await database.query(`SELECT job_id, task_index, task_status, thread_id FROM agent_job_tasks WHERE job_id = $1 ORDER BY task_index`, [child.jobId]))
      .toEqual([
        { job_id: child.jobId, task_index: 0, task_status: 'running', thread_id: 'projection-live-thread' },
        { job_id: child.jobId, task_index: 1, task_status: 'queued', thread_id: 'projection-live-thread-2' },
      ]);
    await database.query(`DELETE FROM agent_job_tasks WHERE job_id = $1`, [ancestor.jobId]);
    await database.query(normalizeTasks);
    await database.query(normalizeTasks);
    expect(await database.query(`SELECT thread_id FROM agent_job_tasks WHERE job_id = $1`, [ancestor.jobId]))
      .toEqual([{ thread_id: 'projection-root-thread' }]);

    const projected = await repository.jobsForProjection(120_000);
    expect(projected.map(item => item.jobId)).toEqual([ancestor.jobId, cycleA.jobId, cycleB.jobId, recentTerminal.jobId, child.jobId]);
    expect(projected.find(item => item.jobId === child.jobId)).toMatchObject({ parentJobId: ancestor.jobId, parentTaskIndex: 0 });
    expect(projected[0].tasks[0]).toMatchObject({ threadId: 'projection-root-thread', status: 'completed' });
    expect(projected.find(item => item.jobId === child.jobId)?.tasks).toMatchObject([
      { threadId: 'projection-live-thread', status: 'running', visibility: 'tab' },
      { threadId: 'projection-live-thread-2', status: 'queued' },
    ]);
    expect(projected.map(item => item.jobId)).not.toContain(expired.jobId);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE SYNTHETIC PAYLOAD');

    await repository.replaceState({ ...ancestor, tasks: [{ ...ancestor.tasks[0], threadId: 'projection-root-thread-renamed' }] });
    expect((await repository.job(child.jobId))?.parentJobId).toBeNull();
    await repository.replaceState({ ...ancestor, tasks: ancestor.tasks });
    expect((await repository.job(child.jobId))?.parentJobId).toBe(ancestor.jobId);
  });


  it('keeps the full completion status needed for job rollup and delivers markers without stale rows', async() => {
    // risk: compact projection misreports settled task status or loses delivery freshness
    const input = job('projection-completion-rollup');
    const completion = { label: 'lane', status: 'completed' as const, output: 'synthetic', threadId: 'projection-completion-thread' };
    input.tasks[0] = { ...input.tasks[0], status: 'error', completion };
    await repository.insertJob(input);
    await repository.updateTaskCompletions(input.jobId, 0, input.tasks, [completion]);
    await repository.markTaskCompletionFirstDelivered(input.jobId, 0, 10);
    await repository.markTaskCompletionDelivered(input.jobId, 0, 20);
    const [projection] = await repository.jobsForProjection(120_000);
    expect(projection.tasks[0]).toMatchObject({ status: 'error', completion: { status: 'completed' } });
    expect(projection.results).toEqual([]); // state rollup reads task.completion.status; state projection never reads result payloads

    await repository.updateTasks(input.jobId, [input.tasks[0], { ...input.tasks[0], status: 'queued' }]);
    expect(await database.query(`SELECT task_index FROM agent_job_tasks WHERE job_id = $1 ORDER BY task_index`, [input.jobId]))
      .toEqual([{ task_index: 0 }, { task_index: 1 }]);
    await repository.updateTasks(input.jobId, [input.tasks[0]]);
    expect(await database.query(`SELECT task_index FROM agent_job_tasks WHERE job_id = $1 ORDER BY task_index`, [input.jobId]))
      .toEqual([{ task_index: 0 }]);
  });

  it('includes every ancestor beyond the old fixed recursion depth', async() => {
    // risk: live descendants detach from deep managers when an arbitrary ancestry cap is reached
    const base = Date.now() - 60 * 60_000;
    let parentThreadId = 'projection-deep-root';
    const ids: string[] = [];
    for (let depth = 0; depth < 12; depth++) {
      const current = job(`projection-deep-${ depth }`, base + depth);
      current.parentThreadId = parentThreadId;
      current.tasks[0] = { ...current.tasks[0], status: 'completed', threadId: `projection-deep-thread-${ depth }` };
      await repository.insertJob(current);
      await repository.complete({ ...current, status: 'completed', finishedAt: base + depth });
      ids.push(current.jobId);
      parentThreadId = `projection-deep-thread-${ depth }`;
    }
    const leaf = { ...job('projection-deep-live-leaf'), parentThreadId, tasks: [{
      agentId: 'leaf', label: 'leaf', prompt: 'synthetic', status: 'running' as const, threadId: 'projection-deep-live-thread',
    }] };
    await repository.insertJob(leaf);
    const result = await repository.jobsForProjection(0);
    expect(result.map(item => item.jobId)).toEqual([...ids, leaf.jobId]);
    expect(result[result.length - 1]).toMatchObject({ parentJobId: ids[ids.length - 1], parentTaskIndex: 0 });
  });

  it('cascades normalized task rows and detaches children when a job is deleted', async() => {
    // risk: retention leaves orphaned typed rows or invalid parent identities
    const parent = job('projection-delete-parent');
    parent.tasks[0] = { ...parent.tasks[0], status: 'completed', threadId: 'projection-delete-parent-thread' };
    await repository.insertJob(parent);
    const child = job('projection-delete-child');
    child.parentThreadId = 'projection-delete-parent-thread';
    await repository.insertJob(child);
    expect((await repository.job(child.jobId))?.parentJobId).toBe(parent.jobId);

    await database.query(`DELETE FROM agent_jobs WHERE job_id = $1`, [parent.jobId]);
    expect(await database.query(`SELECT task_index FROM agent_job_tasks WHERE job_id = $1`, [parent.jobId])).toEqual([]);
    expect(await repository.job(child.jobId)).toMatchObject({ parentJobId: null, parentTaskIndex: null });
  });

  it('keeps normalized task status current through stop, reopen, park, resume, and completion writes', async() => {
    // risk: indexed task status diverges from the durable lifecycle record
    const input = job('projection-lifecycle-sync');
    input.tasks[0] = { ...input.tasks[0], status: 'completed', generation: 1 };
    await repository.insertJob(input);
    await repository.complete({ ...input, status: 'completed', finishedAt: Date.now() });
    await repository.claimReopen(input.jobId, 0, 1);
    expect(await database.query(`SELECT task_status FROM agent_job_tasks WHERE job_id = $1`, [input.jobId]))
      .toEqual([{ task_status: 'running' }]);
    await repository.park(input.jobId, [{ ...input.tasks[0], status: 'parked' }], 1, 'parked');
    expect(await database.query(`SELECT task_status FROM agent_job_tasks WHERE job_id = $1`, [input.jobId]))
      .toEqual([{ task_status: 'parked' }]);
    await repository.resume(input.jobId, [{ ...input.tasks[0], status: 'running' }]);
    await repository.stop(input.jobId, [{ ...input.tasks[0], status: 'stopped' }], 'human', 'synthetic test');
    expect(await database.query(`SELECT task_status FROM agent_job_tasks WHERE job_id = $1`, [input.jobId]))
      .toEqual([{ task_status: 'stopped' }]);
  });

  it('mirrors every direct repository lifecycle/CAS write and rejects out-of-order task state', async() => {
    // risk: a direct SQL write path bypasses normalized state, or a stale CAS resurrects it
    const input = job('projection-all-write-paths');
    input.parentThreadId = 'projection-write-path-root';
    input.tasks[0] = { ...input.tasks[0], status: 'running', startedAt: input.createdAt, threadId: 'projection-write-path-thread', generation: 1 };
    await repository.insertJob(input);
    const taskRow = async() => (await database.query(`SELECT task_status, thread_id, parent_job_id, completion_status
      FROM agent_job_tasks t LEFT JOIN agent_jobs j USING (job_id) WHERE t.job_id = $1 AND task_index = 0`, [input.jobId]))[0];
    expect(await taskRow()).toMatchObject({ task_status: 'running', thread_id: 'projection-write-path-thread' });

    const parked = { ...input, status: 'parked' as const, tasks: [{ ...input.tasks[0], status: 'parked' as const, waitReason: 'children' }] };
    await repository.replaceState(parked);
    expect(await taskRow()).toMatchObject({ task_status: 'parked', thread_id: 'projection-write-path-thread' });
    const accepted = await repository.replaceStateIfActivityUnchanged({ ...parked, status: 'running', tasks: [{ ...parked.tasks[0], status: 'running' }] }, 0, input.createdAt);
    expect(accepted).toBe(true);
    const stale = await repository.replaceStateIfActivityUnchanged({ ...parked, status: 'running', tasks: [{ ...parked.tasks[0], status: 'queued', threadId: 'stale-thread' }] }, 0, input.createdAt - 1);
    expect(stale).toBe(false);
    expect(await taskRow()).toMatchObject({ task_status: 'running', thread_id: 'projection-write-path-thread' });

    await repository.updateTasks(input.jobId, [{ ...input.tasks[0], status: 'queued' }]);
    await repository.markTaskCompletionFirstDelivered(input.jobId, 0, 10);
    await repository.markTaskCompletionDelivered(input.jobId, 0, 20);
    const completion = { label: 'lane', status: 'completed' as const, output: 'synthetic', threadId: 'projection-write-path-thread' };
    const completedTasks = [{ ...input.tasks[0], status: 'completed' as const, completion, returnedAt: Date.now(), finishedAt: Date.now() }];
    await repository.updateTaskCompletions(input.jobId, 0, completedTasks, [completion]);
    expect(await taskRow()).toMatchObject({ task_status: 'completed', completion_status: 'completed' });
    await repository.complete({ ...input, status: 'completed', finishedAt: Date.now(), tasks: completedTasks, results: [completion] });
    await repository.markCompletionDelivered(input.jobId);
    const reopen = await repository.claimReopen(input.jobId, 0, 1);
    expect(reopen?.generation).toBe(2);
    expect(await taskRow()).toMatchObject({ task_status: 'running', completion_status: null });

    await repository.park(input.jobId, [{ ...input.tasks[0], status: 'parked' }], 1, 'parked');
    expect(await taskRow()).toMatchObject({ task_status: 'parked' });
    await repository.resume(input.jobId, [{ ...input.tasks[0], status: 'running' }]);
    expect(await taskRow()).toMatchObject({ task_status: 'running' });
    await repository.dismissTasks(input.jobId, input.parentThreadId!, [{ ...input.tasks[0], status: 'running', dismissed: true }], false);
    expect(await database.query(`SELECT dismissed FROM agent_job_tasks WHERE job_id = $1 AND task_index = 0`, [input.jobId]))
      .toEqual([{ dismissed: true }]);
    await repository.fail(input.jobId, 'synthetic failure', [{ ...input.tasks[0], status: 'error' }]);
    expect(await taskRow()).toMatchObject({ task_status: 'error' });
    await repository.stop(input.jobId, [{ ...input.tasks[0], status: 'stopped' }], 'human', 'synthetic stop');
    expect(await taskRow()).toMatchObject({ task_status: 'stopped' });
    await repository.saveStoppedResults(input.jobId, [], [{ ...input.tasks[0], status: 'stopped', summary: 'late result' }]);
    expect(await taskRow()).toMatchObject({ task_status: 'stopped' });
    await repository.replaceState({ ...input, status: 'failed', tasks: [{ ...input.tasks[0], status: 'error' }] });
    expect((await repository.job(input.jobId))?.status).toBe('stopped');
    expect(await taskRow()).toMatchObject({ task_status: 'error' });
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
