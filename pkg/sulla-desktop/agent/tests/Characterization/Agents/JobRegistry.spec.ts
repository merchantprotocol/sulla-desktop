// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('agent job lifecycle with real Postgres', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let messaging: typeof import('../../../database/models/AgentJobMessagingModel');

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    registry = await import('../../../tools/agents/jobRegistry');
    messaging = await import('../../../database/models/AgentJobMessagingModel');
  }, 60_000);
  afterAll(async() => database.dispose());

  it('applies every real migration and is idempotent on re-run', async() => {
    await database.applyMigrations();
    const [{ count }] = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM sulla_migrations');
    const { migrationsRegistry } = await import('../../../database/migrations');
    expect(Number(count)).toBe(migrationsRegistry.length);
  });

  it('creates hidden and tab jobs, updates tasks, and finds the owning thread', async() => {
    const task = { agentId: 'worker', label: 'lane', prompt: 'work', status: 'queued' as const, threadId: 'thread-lifecycle', depth: 2 };
    const hidden = await registry.createJob([task], 'parent', 'parent-thread');
    const tab = await registry.createJob([{ ...task, threadId: 'thread-tab' }], 'parent', 'parent-thread', { visibility: 'tab' });
    await registry.updateJobTask(hidden.jobId, 0, { status: 'running', startedAt: Date.now() });
    expect((await registry.findTaskByThread('thread-lifecycle'))?.job.jobId).toBe(hidden.jobId);
    expect(await registry.delegationDepthForThread('thread-lifecycle')).toBe(2);
    expect(tab.visibility).toBe('tab');
    expect(registry.MAX_SUBAGENT_DEPTH).toBe(3);
  });

  it('queues messages in order and marks each delivered exactly once', async() => {
    const job = await registry.createJob([{ agentId: 'worker', label: 'msg', prompt: 'work', status: 'running', threadId: 'thread-msg' }]);
    const target = (await messaging.AgentJobMessagingModel.targetsForJob(job.jobId))[0];
    const first = await messaging.AgentJobMessagingModel.queueMessage(target, 'first');
    const second = await messaging.AgentJobMessagingModel.queueMessage(target, 'second');
    expect((await messaging.AgentJobMessagingModel.pendingMessagesForThread('thread-msg')).map(item => item.message)).toEqual(['first', 'second']);
    await messaging.AgentJobMessagingModel.markMessagesDelivered([first.id, second.id], 'thread-msg');
    await messaging.AgentJobMessagingModel.markMessagesDelivered([first.id, second.id], 'thread-msg');
    expect(await messaging.AgentJobMessagingModel.pendingMessagesForThread('thread-msg')).toEqual([]);
  });

  it('records one contract return and refuses duplicates and late returns', async() => {
    const job = await registry.createJob([{ agentId: 'worker', label: 'return', prompt: 'work', status: 'running' }], undefined, undefined, { visibility: 'tab' });
    await registry.recordTaskReturn(job.jobId, 0, { result: { answer: 42 }, summary: 'done', status: 'completed' });
    await expect(registry.recordTaskReturn(job.jobId, 0, { result: {}, status: 'completed' })).rejects.toThrow('already returned');
    const stopped = await registry.createJob([{ agentId: 'worker', label: 'stop', prompt: 'work', status: 'running' }]);
    expect(registry.abortJob(stopped.jobId)).toBe('stopped');
    expect(registry.getJobAbortSignal(stopped.jobId)?.aborted).toBe(true);
    expect(registry.abortJob(stopped.jobId)).toBe('already-finished');
    expect(registry.abortJob('missing')).toBe('not-found');
    await expect(registry.recordTaskReturn(stopped.jobId, 0, { result: {}, status: 'completed' })).rejects.toThrow('no longer accepts');
  });

  it('delivers a durable completion at most once', async() => {
    const job = await registry.createJob([{ agentId: 'worker', label: 'complete', prompt: 'work', status: 'running' }], 'parent', 'completion-parent');
    await registry.completeJob(job.jobId, [{ label: 'complete', status: 'completed', output: 'ok', threadId: 'child' }]);
    expect((await registry.getPendingCompletions()).map(item => item.jobId)).toContain(job.jobId);
    await registry.markCompletionDelivered(job.jobId);
    await registry.markCompletionDelivered(job.jobId);
    expect((await registry.getPendingCompletions()).map(item => item.jobId)).not.toContain(job.jobId);
  });

  it('BL-043 bounds terminal history while retaining every active job', async() => {
    const now = Date.now();
    const jobs = Array.from({ length: 2_000 }, (_, index) => ({
      jobId: `finished-${ index }`, status: 'completed' as const, createdAt: now + index, finishedAt: now + index,
      taskCount: 0, results: [], tasks: [],
    }));
    jobs.push({ ...jobs[0], jobId: 'active', status: 'running', finishedAt: null });
    const listed = registry.boundJobList(jobs, 25, true);
    expect(listed).toHaveLength(26);
    expect(listed.some(job => job.jobId === 'active')).toBe(true);
    expect(listed.filter(job => job.status !== 'running')).toHaveLength(25);
  });
});
