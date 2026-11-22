// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AgentJobRepository } from '../../../app/Repositories/AgentJobRepository';
import { AgentJobRetentionRepository } from '../../../app/Repositories/AgentJobRetentionRepository';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import { TestDatabase } from '../../Support/TestDatabase';
import { up as normalizeTasks } from '../../../database/migrations/0155_normalize_agent_job_tasks';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('AgentJobRepository', () => {
  const database = new TestDatabase();
  let queryCount = 0;
  let repository: AgentJobRepository;
  let retention: AgentJobRetentionRepository;

  beforeAll(async() => {
    await database.initialize();
    const connection = new PostgresConnection({ query: async(sql, bindings) => {
      queryCount += 1;
      const rows = await database.query(sql, [...(bindings ?? [])]);
      return { rows, rowCount: rows.length };
    } });
    repository = new AgentJobRepository(connection);
    retention = new AgentJobRetentionRepository(connection);
  }, 60_000);
  afterAll(async() => database.dispose());
  // Every test owns the table: projection/live/pending reads are global, so leftovers from earlier tests leak in.
  beforeEach(async() => { await database.query('TRUNCATE agent_jobs CASCADE') });

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

  it('finds an inline review only for the same saved reviewer selection', async() => {
    // risk: a review launched for an earlier saved selection is returned as the answer to a later one.
    // Every Workflow save writes binding revision 1, so only the edit token tells two saves apart.
    const review = (jobId: string, editToken?: string): AgentJob => ({
      ...job(jobId), parentThreadId: 'inline-review-parent',
      tasks: [{
        agentId: 'reviewer', label: 'Review', prompt: 'review', status: 'running', workflowStep: 'review',
        followUpOf: { jobId: 'implementation', taskIndex: 1 }, inlineReviewDigest: 'same-bytes',
        workerModelRoute: { version: 1, slug: 'reviewer', agentId: 'def-reviewer', revision: 1, selected: 0, candidates: [{ provider: 'codex', model: 'gpt-sol' }], ...(editToken ? { editToken } : {}) },
      }],
    });
    const first = review('inline-review-save-1', 'save-1');
    await repository.insertJob(first);
    await repository.complete({ ...first, status: 'completed', finishedAt: Date.now() });

    expect((await repository.findInlineReview('inline-review-parent', review('retry', 'save-1').tasks[0]))?.jobId).toBe(first.jobId);
    expect(await repository.findInlineReview('inline-review-parent', review('next-save', 'save-2').tasks[0])).toBeUndefined();
    expect(await repository.findInlineReview('inline-review-parent', review('no-token').tasks[0])).toBeUndefined();

    // A route saved before tokens were recorded still matches itself.
    const legacy = review('inline-review-legacy');
    legacy.tasks[0].inlineReviewDigest = 'legacy-bytes';
    await repository.insertJob(legacy);
    expect((await repository.findInlineReview('inline-review-parent', legacy.tasks[0]))?.jobId).toBe(legacy.jobId);
    expect(await repository.findInlineReview('inline-review-parent', { ...legacy.tasks[0], workerModelRoute: { ...legacy.tasks[0].workerModelRoute!, editToken: 'save-3' } })).toBeUndefined();
  });

  it('reads a chat lineage whose saved job has an empty task and result slot, keeping later indexes', async() => {
    // risk: one legacy gap fails the whole chat's handoff history and outcomes read
    const sparse = { ...job('lineage-sparse'), parentThreadId: 'lineage-sparse-root' };
    await repository.insertJob(sparse);
    const completion = { label: 'second', status: 'completed', output: 'report' };
    const kept = { agentId: 'worker', label: 'second', prompt: 'work', status: 'completed', result: { large: true }, completion };
    await database.query('UPDATE agent_jobs SET tasks = $2::jsonb, results = $3::jsonb, task_count = 2 WHERE job_id = $1',
      [sparse.jobId, JSON.stringify([null, kept]), JSON.stringify([null, completion])]);

    for (const includeReports of [false, true]) {
      const rows = await repository.lineageForParentThread('lineage-sparse-root', 100, includeReports);
      expect(rows.map(row => row.jobId)).toEqual([sparse.jobId]);
      expect(rows[0].tasks).toHaveLength(2);
      expect(rows[0].tasks[0]).toBeNull();
      expect(rows[0].tasks[1]).toMatchObject({ agentId: 'worker', label: 'second' });
      expect(rows[0].tasks[1]).not.toHaveProperty('result');
      expect(rows[0].results).toEqual(includeReports ? [null, completion] : []);
    }
  });

  it('lists active and finished jobs whose saved task array has an empty slot, keeping later indexes', async() => {
    // risk: one legacy gap fails the fleet list and startup recovery for every job, not only its own
    const base = Date.now();
    const live = job('list-sparse-live', base);
    const done = job('list-sparse-done', base - 1_000);
    const healthy = job('list-sparse-healthy', base - 2_000);
    for (const input of [live, done, healthy]) await repository.insertJob(input);
    await repository.complete({ ...done, status: 'completed', finishedAt: Date.now() });
    const kept = { agentId: 'worker', label: 'second', prompt: 'work', status: 'running', result: { large: true }, completion: { label: 'second', status: 'completed', output: 'report' } };
    await database.query('UPDATE agent_jobs SET tasks = $2::jsonb, task_count = 2 WHERE job_id = ANY($1::text[])',
      [[live.jobId, done.jobId], JSON.stringify([null, kept])]);

    const listed = await repository.jobsForList(25, true);
    expect(listed.map(row => row.jobId)).toEqual([live.jobId, done.jobId, healthy.jobId]);
    for (const row of listed.slice(0, 2)) {
      expect(row.tasks).toHaveLength(2);
      // The gap stays at index 0 as an entry without fields; the real task stays at index 1.
      expect(row.tasks[0]).toMatchObject({ agentId: null, label: null, status: null });
      expect(row.tasks[1]).toMatchObject({ agentId: 'worker', label: 'second', status: 'running' });
      expect(row.tasks[1]).not.toHaveProperty('result');
    }
    expect(listed[2].tasks).toEqual([expect.objectContaining({ agentId: 'worker', label: 'lane', status: 'running' })]);
    // Startup recovery and the active-work readers use the same query without finished jobs.
    expect((await repository.activeJobs()).map(row => row.jobId)).toEqual([live.jobId, healthy.jobId]);
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

  it('keeps a live task’s workflow stage in the compact projection and leaves an untagged sibling untagged', async() => {
    // risk: the live snapshot reports no stage, which replaces the saved stage of a running or parked handoff in AI Team
    const input = job('projection-workflow-step');
    input.tasks = [
      { agentId: 'builder', label: 'Implement export', prompt: 'work', status: 'running', workflowStep: 'implementation' },
      { agentId: 'worker', label: 'Unrelated lookup', prompt: 'work', status: 'running' },
      { agentId: 'reviewer', label: 'Review export', prompt: 'work', status: 'parked', workflowStep: 'review', followUpOf: { jobId: 'projection-workflow-step', taskIndex: 0 } },
    ];
    input.taskCount = 3;
    await repository.insertJob(input);

    const [projection] = await repository.jobsForProjection(120_000);
    expect(projection.jobId).toBe(input.jobId);
    expect(projection.tasks.map(task => task.label)).toEqual(['Implement export', 'Unrelated lookup', 'Review export']);
    expect(projection.tasks.map(task => task.workflowStep ?? null)).toEqual(['implementation', null, 'review']);
    // The stage sits beside the other routing fields the projection already preserves.
    expect(projection.tasks[2]).toMatchObject({ status: 'parked', followUpOf: { jobId: input.jobId, taskIndex: 0 } });
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

  it('projects completion status separately from a stale task error status', async() => {
    // risk: a successfully completed task is rolled up as failed after compact projection
    const input = job('projection-completion-status');
    const responseModels = [{ model: 'gpt-6.2-sol', provider: 'codex', effort: 'high', source: 'resolved' as const }];
    const decisionIds = ['decision-one'];
    input.tasks[0] = { ...input.tasks[0], status: 'error', responseModels, decisionIds, completion: {
      label: 'lane', status: 'completed', output: 'synthetic success', threadId: 'projection-completion-thread',
    } };
    await repository.insertJob(input);
    await repository.complete({ ...input, status: 'completed', finishedAt: Date.now() });

    const [projected] = await repository.jobsForProjection(120_000);
    expect(projected.tasks[0]).toMatchObject({
      status: 'error', completion: { status: 'completed' }, responseModels, decisionIds,
    });
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

  it('reads live jobs, thread jobs, task-thread owners and pending completions without scanning history', async() => {
    // risk: polling cost grows with every historical job (seq scan + jsonb detoast)
    const live = job('poll-live');
    const done = { ...job('poll-done'), status: 'completed' as const, finishedAt: Date.now() };
    const stale = { ...job('poll-stale'), parentThreadId: 'poll-parent', parentChannel: 'sulla-desktop' };
    stale.tasks[0] = { ...stale.tasks[0], threadId: 'poll-task-thread',
      completion: { label: 'lane', status: 'completed', output: 'ok', threadId: 'poll-task-thread', contract: 'result' } };
    for (const item of [live, done, stale]) await repository.insertJob(item);
    await repository.complete(done); // insertJob always records a launch as running
    await repository.complete({ ...stale, status: 'completed', finishedAt: Date.now() });
    expect((await repository.liveJobs()).map(item => item.jobId)).toContain('poll-live');
    expect((await repository.liveJobs()).map(item => item.jobId)).not.toContain('poll-done');
    expect((await repository.findByTaskThread('poll-task-thread'))?.jobId).toBe('poll-stale');
    const pending = await repository.pendingCompletions(10);
    expect(pending.map(item => item.jobId)).toContain('poll-stale');
    expect(await repository.pendingCompletions(1)).toHaveLength(1);
    await repository.markCompletionDelivered('poll-stale');
    expect((await repository.pendingCompletions()).map(item => item.jobId)).not.toContain('poll-stale');
  });

  it('keeps a live descendant visible through a terminal parent older than the display window', async() => {
    // risk: live work disappears from the Live Agents projection after an old parent ages out
    const root = 'lineage-old-parent-root';
    const middle = { ...job('lineage-old-parent-mid'), parentThreadId: root };
    middle.tasks[0] = { ...middle.tasks[0], threadId: 'lineage-old-parent-mid-thread', status: 'completed' };
    await repository.insertJob(middle);
    await repository.complete({ ...middle, status: 'completed', finishedAt: Date.now() });
    await database.query(`UPDATE agent_jobs SET finished_at = now() - interval '25 hours' WHERE job_id = $1`, [middle.jobId]);
    const live = { ...job('lineage-old-parent-live'), parentThreadId: 'lineage-old-parent-mid-thread' };
    await repository.insertJob(live);

    const rows = await repository.lineageForParentThread(root);
    expect(rows.map(item => item.jobId)).toContain(live.jobId);
    expect(rows.map(item => item.jobId)).not.toContain(middle.jobId);
  });

  it('deletes eligible jobs with cascading child rows, but protects live and undelivered references', async() => {
    // risk: retention orphaning operational data or deleting work before its completion is delivered
    const eligible = job('retention-eligible-a');
    const secondEligible = job('retention-eligible-b');
    const live = job('retention-live');
    const parked = job('retention-parked');
    parked.tasks[0] = { ...parked.tasks[0], status: 'parked' };
    for (const item of [eligible, secondEligible]) item.tasks[0] = { ...item.tasks[0], status: 'completed' };
    const undelivered = { ...job('retention-undelivered'), parentChannel: 'sulla-desktop', parentThreadId: 'parent' };
    undelivered.tasks[0] = { ...undelivered.tasks[0], status: 'completed',
      completion: { label: 'lane', status: 'completed', output: 'pending', threadId: 'undelivered-thread' } };
    for (const item of [eligible, secondEligible, live, parked, undelivered]) await repository.insertJob(item);
    await repository.complete({ ...eligible, status: 'completed', finishedAt: Date.now(), completionDeliveredAt: Date.now() });
    await repository.complete({ ...secondEligible, status: 'completed', finishedAt: Date.now(), completionDeliveredAt: Date.now() });
    await repository.complete({ ...undelivered, status: 'completed', finishedAt: Date.now() });
    await database.query(`UPDATE agent_jobs SET status = 'parked', finished_at = now() - interval '25 hours' WHERE job_id = $1`, [parked.jobId]);
    await database.query(`UPDATE agent_jobs SET finished_at = now() - interval '25 hours' WHERE job_id = ANY($1::text[])`, [[eligible.jobId, secondEligible.jobId, undelivered.jobId, parked.jobId]]);
    await database.query(`INSERT INTO agent_job_messages (id, job_id, task_index, message) VALUES ('retention-message', $1, 0, 'x')`, [eligible.jobId]);
    await database.query(`INSERT INTO agent_job_checkins (job_id, task_index, step, summary) VALUES ($1, 0, 's', 'x')`, [eligible.jobId]);
    await database.query(`INSERT INTO agent_job_result_history (job_id, task_index, generation, task_status) VALUES ($1, 0, 1, 'completed')`, [eligible.jobId]);
    await database.query(`INSERT INTO agent_job_task_reopens (job_id, task_index) VALUES ($1, 0)`, [eligible.jobId]);
    await database.query(`INSERT INTO agent_job_review_items (job_id, task_index, item_id, text) VALUES ($1, 0, 'item', 'x')`, [eligible.jobId]);
    await database.query(`INSERT INTO agent_task_waits (job_id, task_index, wake_at, reason, state) VALUES ($1, 0, now(), 'x', 'cancelled')`, [eligible.jobId]);
    await database.query(`INSERT INTO agent_stranded_episodes (manager_job_id, manager_task_index, state_key, parent_channel, parent_thread_id, label, reason) VALUES ($1, 0, 'state', 'sulla-desktop', 'parent', 'lane', 'x')`, [eligible.jobId]);

    expect(await retention.deleteExpiredBatch(24 * 60 * 60 * 1000, 1)).toBe(1);
    expect(await database.query(`SELECT job_id FROM agent_jobs WHERE job_id = ANY($1::text[]) ORDER BY job_id`, [[eligible.jobId, secondEligible.jobId, live.jobId, undelivered.jobId, parked.jobId]])).toEqual([
      expect.objectContaining({ job_id: secondEligible.jobId }), expect.objectContaining({ job_id: live.jobId }), expect.objectContaining({ job_id: parked.jobId }), expect.objectContaining({ job_id: undelivered.jobId }),
    ]);
    expect(await retention.deleteExpiredBatch(24 * 60 * 60 * 1000, 1)).toBe(1);
    for (const [table, column] of [
      ['agent_job_messages', 'job_id'], ['agent_job_checkins', 'job_id'],
      ['agent_job_result_history', 'job_id'], ['agent_job_task_reopens', 'job_id'],
      ['agent_job_review_items', 'job_id'], ['agent_task_waits', 'job_id'],
      ['agent_stranded_episodes', 'manager_job_id'], ['agent_job_tasks', 'job_id'],
    ]) {
      expect(await database.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [eligible.jobId])).toHaveLength(0);
    }
  });

  it('expires undelivered jobs only when nothing is left to deliver or the parent abandoned them', async() => {
    // risk: undeliverable rows pinned forever, or a pending completion dropped before its parent wakes
    const parent = { parentChannel: 'sulla-desktop', parentThreadId: 'retention-parent' };
    const nothingPending = { ...job('retention-nothing-pending'), ...parent };
    const pendingRecent = { ...job('retention-pending-recent'), ...parent };
    const pendingAbandoned = { ...job('retention-pending-abandoned'), ...parent };
    nothingPending.tasks[0] = { ...nothingPending.tasks[0], status: 'completed' };
    for (const item of [pendingRecent, pendingAbandoned]) {
      item.tasks[0] = { ...item.tasks[0], status: 'completed',
        completion: { label: 'lane', status: 'completed', output: 'pending', threadId: `${ item.jobId }-thread` } };
    }
    for (const item of [nothingPending, pendingRecent, pendingAbandoned]) {
      await repository.insertJob(item);
      await repository.complete({ ...item, status: 'completed', finishedAt: Date.now() });
    }
    await database.query(`UPDATE agent_jobs SET finished_at = now() - interval '25 hours' WHERE job_id = ANY($1::text[])`, [[nothingPending.jobId, pendingRecent.jobId]]);
    await database.query(`UPDATE agent_jobs SET finished_at = now() - interval '8 days' WHERE job_id = $1`, [pendingAbandoned.jobId]);

    expect(await retention.drainExpired({ batchSize: 1, maxBatches: 5, pauseMs: 0 })).toBe(2);
    const left = await database.query(`SELECT job_id FROM agent_jobs WHERE job_id = ANY($1::text[])`, [[nothingPending.jobId, pendingRecent.jobId, pendingAbandoned.jobId]]);
    expect(left.map((row: { job_id: string }) => row.job_id)).toEqual([pendingRecent.jobId]);
  });

  it('keeps the lineage recursion on typed task rows and returns each descendant once', async() => {
    // risk: lineage poll copied task jsonb through every recursion level (275 ms mean, 5k calls)
    const root = 'lineage-bound-root';
    const mid = { ...job('lineage-bound-mid'), parentThreadId: root };
    mid.tasks[0] = { ...mid.tasks[0], threadId: 'lineage-bound-mid-thread' };
    const leaf = { ...job('lineage-bound-leaf'), parentThreadId: 'lineage-bound-mid-thread' };
    await repository.insertJob(mid); await repository.insertJob(leaf);
    const rows = await repository.lineageForParentThread(root);
    expect(rows.map(item => item.jobId)).toEqual(['lineage-bound-mid', 'lineage-bound-leaf']);
  });
});
