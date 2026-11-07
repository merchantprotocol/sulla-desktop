// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StopPrincipal } from '../../../app/ValueObjects/StopPrincipal';

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
    expect(registry.abortJob(stopped.jobId, StopPrincipal.human(), 'test stop')).toBe('stopped');
    expect(registry.getTaskAbortSignal(stopped.jobId, 0)?.aborted).toBe(true);
    expect(registry.abortJob(stopped.jobId, StopPrincipal.human(), 'test stop')).toBe('already-finished');
    expect(registry.abortJob('missing', StopPrincipal.human(), 'test stop')).toBe('not-found');
    await expect(registry.recordTaskReturn(stopped.jobId, 0, { result: {}, status: 'completed' })).rejects.toThrow('no longer accepts');
  });

  it('delivers a durable completion at most once', async() => {
    const job = await registry.createJob([{ agentId: 'worker', label: 'complete', prompt: 'work', status: 'running' }], 'parent', 'completion-parent');
    const result = { label: 'complete', status: 'completed' as const, output: 'ok', threadId: 'child' };
    await registry.recordTaskCompletion(job.jobId, 0, result);
    await registry.completeJob(job.jobId, [result]);
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
    await check.call({ scope: 'all' });
    expect((await registry.getJobsForParentThread('retention-parent')).map(item => item.jobId)).toContain(job.jobId);
    expect((await sendJobMessage({ jobId: job.jobId, message: 'lookup only' })).successBoolean).toBe(false);

    const [jobRow] = await database.query<{ results: unknown[] }>('SELECT results FROM agent_jobs WHERE job_id = $1', [job.jobId]);
    const [{ count: checkins }] = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_job_checkins WHERE job_id = $1', [job.jobId]);
    const [{ count: messages }] = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_job_messages WHERE job_id = $1', [job.jobId]);
    expect(jobRow.results).toEqual([{ label: 'retained', status: 'completed', output: { answer: 42 }, threadId }]);
    expect(Number(checkins)).toBe(1);
    expect(Number(messages)).toBe(1);
  });


  it('keeps scope mine isolated across two real chat trees and reports persisted lineage titles', async() => {
    // risk: policy / one chat can inspect another chat's delegated work
    const stamp = Date.now();
    const rootA = `fleet-root-a-${ stamp }`;
    const rootB = `fleet-root-b-${ stamp }`;
    await database.query(`INSERT INTO conversation_history (id, thread_id, type, title) VALUES
      ($1, $1, 'chat', 'Root A title'), ($2, $2, 'chat', 'Root B title')`, [rootA, rootB]);
    const managerA = await registry.createJob([
      { agentId: 'unused', label: 'unused', prompt: 'work', status: 'running', threadId: `fleet-unused-${ stamp }` },
      { agentId: 'manager-a', label: 'manager-a', prompt: 'work', status: 'running', threadId: `fleet-manager-a-${ stamp }` },
    ], 'sulla-desktop', rootA, { parentAgentId: 'sulla' });
    const workerA = await registry.createJob([
      { agentId: 'worker-a', label: 'worker-a', prompt: 'work', status: 'running', threadId: `fleet-worker-a-${ stamp }` },
    ], 'codex-sol-worker', `fleet-manager-a-${ stamp }`, { parentAgentId: 'manager-a' });
    const grandchildA = await registry.createJob([
      { agentId: 'grandchild-a', label: 'grandchild-a', prompt: 'work', status: 'running', threadId: `fleet-grandchild-a-${ stamp }` },
    ], 'codex-sol-worker', `fleet-worker-a-${ stamp }`, { parentAgentId: 'worker-a' });
    const managerB = await registry.createJob([
      { agentId: 'manager-b', label: 'manager-b', prompt: 'work', status: 'running', threadId: `fleet-manager-b-${ stamp }` },
    ], 'sulla-desktop', rootB, { parentAgentId: 'sulla' });

    const check = new CheckAgentJobsHarness();
    check.setState({ metadata: { threadId: rootA } });
    const mine = await check.call({ scope: 'mine' });
    const minePayload = JSON.parse(mine.responseString);
    expect(minePayload.jobs.map((value: any) => value.jobId)).toEqual(expect.arrayContaining([managerA.jobId, workerA.jobId, grandchildA.jobId]));
    expect(minePayload.jobs).toHaveLength(3);
    expect(minePayload.jobs.some((value: any) => value.jobId === managerB.jobId)).toBe(false);
    const projectedWorkerA = minePayload.jobs.find((value: any) => value.jobId === workerA.jobId);
    expect(projectedWorkerA).toMatchObject({
      parentThreadId: `fleet-manager-a-${ stamp }`, parentAgentId: 'manager-a', parentJobId: managerA.jobId,
      parentTaskIndex: 1, rootThreadId: rootA, rootChatTitle: 'Root A title',
    });
    expect(projectedWorkerA.tasks[0]).toMatchObject({ parentJobId: managerA.jobId, parentTaskIndex: 1, rootThreadId: rootA, rootChatTitle: 'Root A title' });

    const all = await check.call({ scope: 'all', limit: 100 });
    const allPayload = JSON.parse(all.responseString);
    expect(allPayload.jobs.map((value: any) => value.jobId)).toEqual(expect.arrayContaining([managerA.jobId, workerA.jobId, grandchildA.jobId, managerB.jobId]));
    expect(allPayload.jobs.find((value: any) => value.jobId === managerB.jobId)).toMatchObject({ rootThreadId: rootB, rootChatTitle: 'Root B title' });
  });

  it('projects a real manager team tree and clears its unprocessed rollup after task delivery', async() => {
    // risk: durable worker results are lost or attributed to a sibling manager
    const stamp = Date.now();
    const root = `rollup-root-${ stamp }`;
    const manager = await registry.createJob([
      { agentId: 'manager-a', label: 'manager-a', prompt: 'own', status: 'running', threadId: `rollup-manager-a-${ stamp }` },
      { agentId: 'manager-b', label: 'manager-b', prompt: 'own', status: 'running', threadId: `rollup-manager-b-${ stamp }` },
    ], 'sulla-desktop', root);
    const worker = await registry.createJob([
      { agentId: 'worker', label: 'worker', prompt: 'work', status: 'running', threadId: `rollup-worker-${ stamp }` },
    ], 'coding-manager-sol', `rollup-manager-a-${ stamp }`);
    await messaging.AgentJobMessagingModel.appendCheckin(`rollup-worker-${ stamp }`, { step: 'blocked', summary: 'waiting', blockers: ['dependency'] });
    const grandchild = await registry.createJob([
      { agentId: 'grandchild', label: 'grandchild', prompt: 'work', status: 'running', threadId: `rollup-grandchild-${ stamp }` },
    ], 'codex-sol-worker', `rollup-worker-${ stamp }`);
    await registry.recordTaskCompletion(grandchild.jobId, 0, { label: 'grandchild', status: 'completed', output: 'done', threadId: `rollup-grandchild-${ stamp }` });

    const { agentJobProvider } = await import('../../../app/Providers/AgentJobServiceProvider');
    const { AgentTeamRollupProjector } = await import('../../../app/Services/AgentTeamRollupProjector');
    const snapshot = await agentJobProvider.fleet.list({ scope: 'mine', callerThreadId: root, limit: 100 });
    const rollups = new AgentTeamRollupProjector(() => Date.now()).project(snapshot);
    expect(rollups.get(`${ manager.jobId }#0`)).toMatchObject({ states: { blocked: 1, done: 1 }, openBlockers: 1, unprocessedResults: 1, workerCount: 2 });
    expect(rollups.has(`${ manager.jobId }#1`)).toBe(false);

    const check = new CheckAgentJobsHarness();
    check.setState({ metadata: { threadId: root } });
    const tree = JSON.parse((await check.call({ scope: 'mine', view: 'tree', limit: 100 })).responseString);
    expect(tree.tasks.map((line: any) => line.ref)).toEqual(expect.arrayContaining([`${ manager.jobId }#0`, `${ worker.jobId }#0`, `${ grandchild.jobId }#0`]));
    expect(tree.tasks.every((line: any) => Buffer.byteLength(JSON.stringify(line), 'utf8') <= 400)).toBe(true);

    await registry.markTaskCompletionDelivered(grandchild.jobId, 0);
    const fresh = await agentJobProvider.fleet.list({ scope: 'mine', callerThreadId: root, limit: 100 });
    expect(new AgentTeamRollupProjector(() => Date.now()).project(fresh).get(`${ manager.jobId }#0`)?.unprocessedResults).toBe(0);
  });

  it('serializes stop attribution in list and detail after a repository reload', async() => {
    // risk: audit attribution disappears from supervision after the process cache is cold.
    const job = await registry.createJob([{ agentId: 'worker', label: 'stopped', prompt: 'work', status: 'running', threadId: `stop-reload-${ Date.now() }` }]);
    await registry.stopJobCascade(job.jobId, StopPrincipal.human(), 'operator requested');
    const { agentJobProvider } = await import('../../../app/Providers/AgentJobServiceProvider');
    agentJobProvider.runtime.evictSettledTerminalJobs(0);

    const check = new CheckAgentJobsHarness();
    const detail = JSON.parse((await check.call({ jobId: job.jobId })).responseString!);
    const list = JSON.parse((await check.call({ scope: 'all', includeFinished: true, limit: 100 })).responseString!);
    const listed = list.jobs.find((item: { jobId: string }) => item.jobId === job.jobId);
    expect(detail).toMatchObject({ stoppedBy: 'human', stopReason: 'operator requested' });
    expect(listed).toMatchObject({ stoppedBy: 'human', stopReason: 'operator requested' });
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
