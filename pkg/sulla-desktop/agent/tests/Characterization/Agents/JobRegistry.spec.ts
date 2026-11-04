// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';
import { CheckAgentJobsWorker } from '../../../tools/agents/check_agent_jobs';
import { sendJobMessage } from '../../../tools/agents/send_job_message';

const { wakeParkedAgent } = vi.hoisted(() => ({ wakeParkedAgent: vi.fn(async() => undefined) }));
vi.mock('../../../services/BackendGraphWebSocketService', () => ({
  getBackendGraphWebSocketService: () => ({ wakeParkedAgent }),
}));

class CheckAgentJobsHarness extends CheckAgentJobsWorker {
  call(input: unknown) { return this._validatedCall(input); }
}

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('agent job lifecycle with real Postgres', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let messaging: typeof import('../../../database/models/AgentJobMessagingModel');

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    // pg also consults PGOPTIONS; this covers environments where a connection
    // URL parser drops libpq's `options` query parameter.
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
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

  it('wakes a parked manager but leaves its message pending until the woken turn actually consumes it', async() => {
    // risk: the ack fires at injection time, before the turn runs, so a dead-on-arrival wake silently loses the message
    const job = await registry.createJob([{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own', status: 'running', threadId: 'thread-parked-message' }], 'sulla-desktop', 'root-thread');
    await registry.parkJobTask(job.jobId, 0, 1);

    const response = await sendJobMessage({ jobId: job.jobId, message: 'continue the same goal' });

    expect(response.successBoolean).toBe(true);
    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'thread-parked-message', 'continue the same goal', 'coding-manager-sol', expect.objectContaining({ jobId: job.jobId, taskIndex: 0 }));
    // Ack is written by dispatchToAgent's finally block, only once the woken
    // turn consumed the message — send_job_message itself must not have
    // marked it delivered. See ParkedManagerWakeLifecycle.spec.ts scenario (c)
    // for the full consume-then-ack path with real Postgres.
    expect(await messaging.AgentJobMessagingModel.pendingMessagesForThread('thread-parked-message')).toHaveLength(1);
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

  it('preserves a delivered job and all telemetry across every supervision read path', async() => {
    // risk: reads cascade-delete durable jobs, results, check-ins, and orchestrator messages
    const threadId = `retention-child-${ Date.now() }`;
    const job = await registry.createJob([
      { agentId: 'worker', label: 'retained', prompt: 'work', status: 'running', threadId },
    ], 'parent', 'retention-parent');
    await messaging.AgentJobMessagingModel.appendCheckin(threadId, { step: 'working', summary: 'evidence', percent: 50 });
    const target = (await messaging.AgentJobMessagingModel.targetsForJob(job.jobId))[0];
    await messaging.AgentJobMessagingModel.queueMessage(target, 'retained message');
    await registry.completeJob(job.jobId, [{ label: 'retained', status: 'completed', output: { answer: 42 }, threadId }]);
    await registry.markCompletionDelivered(job.jobId);

    const check = new CheckAgentJobsHarness();
    for (let index = 0; index < 10; index++) await check.call({ jobId: job.jobId });
    await check.call({});
    expect((await registry.getJobsForParentThread('retention-parent')).map(item => item.jobId)).toContain(job.jobId);
    expect((await sendJobMessage({ jobId: job.jobId, message: 'lookup only' })).successBoolean).toBe(false);

    const [jobRow] = await database.query<{ results: unknown[] }>('SELECT results FROM agent_jobs WHERE job_id = $1', [job.jobId]);
    const [{ count: checkins }] = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_job_checkins WHERE job_id = $1', [job.jobId]);
    const [{ count: messages }] = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_job_messages WHERE job_id = $1', [job.jobId]);
    expect(jobRow.results).toEqual([{ label: 'retained', status: 'completed', output: { answer: 42 }, threadId }]);
    expect(Number(checkins)).toBe(1);
    expect(Number(messages)).toBe(1);
  });

  it('excludes dismissed jobs from global list reads', async() => {
    // risk: dismissed work resurfaces in the global agent directory
    const job = await registry.createJob([
      { agentId: 'worker', label: 'dismissed', prompt: 'work', status: 'completed' },
    ], 'parent', 'dismissed-parent');
    await registry.completeJob(job.jobId, [{ label: 'dismissed', status: 'completed', output: 'done', threadId: '' }]);
    expect(await registry.dismissJobTask(job.jobId, 'dismissed-parent', 0)).toBe(true);
    expect((await registry.getJobsForList(100, true)).map(item => item.jobId)).not.toContain(job.jobId);
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
