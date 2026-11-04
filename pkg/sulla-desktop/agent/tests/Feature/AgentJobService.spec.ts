// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDatabase } from '../Support/TestDatabase';

import type { AgentJob } from '../../tools/agents/jobRegistry';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;
dbDescribe('AgentJobService state machine with real Postgres', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../tools/agents/jobRegistry');
  let terminalNotifications: AgentJob[];
  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    registry = await import('../../tools/agents/jobRegistry');
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    terminalNotifications = [];
    agentJobProvider.terminalTransitions.subscribe({ onJobTerminal: (job) => terminalNotifications.push(job) });
  }, 60_000);
  afterAll(async() => database.dispose());
  it('allows running jobs to become completed, failed, or stopped and forbids terminal transitions', async() => {
    // risk: core business state machine
    const completed = await registry.createJob(0);
    await registry.completeJob(completed.jobId, []);
    await registry.failJob(completed.jobId, 'late failure');
    await registry.completeJob(completed.jobId, [{ label: 'late', status: 'error', output: 'late', threadId: 'late' }]);
    expect((await registry.getJob(completed.jobId))?.status).toBe('completed');
    const failed = await registry.createJob(0);
    await registry.failJob(failed.jobId, 'expected');
    await registry.completeJob(failed.jobId, []);
    expect((await registry.getJob(failed.jobId))?.status).toBe('failed');
    const stopped = await registry.createJob(0);
    expect(registry.abortJob(stopped.jobId)).toBe('stopped');
    await registry.completeJob(stopped.jobId, []);
    expect((await registry.getJob(stopped.jobId))?.status).toBe('stopped');
    expect(registry.abortJob(stopped.jobId)).toBe('already-finished');
  });
  it('claims an interrupted hidden job for bounded restart recovery without failing parked managers', async() => {
    // risk: restart silently kills delegated work or creates an infinite boot loop
    const hiddenId = `hydrate-hidden-${ Date.now() }`;
    const parkedId = `hydrate-parked-${ Date.now() }`;
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, created_at, tasks, visibility) VALUES
      ($1, 'running', 1, now(), '[{"agentId":"worker","status":"running","threadId":"worker-thread"}]', 'hidden'),
      ($2, 'parked', 1, now(), '[{"agentId":"manager","status":"parked","threadId":"manager-thread"}]', 'hidden')`, [hiddenId, parkedId]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const first = await agentJobProvider.jobs.claimInterruptedJobs(2);
    expect(first.resumable.map(job => job.jobId)).toContain(hiddenId);
    expect((await agentJobProvider.jobs.job(hiddenId))?.status).toBe('running');
    expect((await agentJobProvider.jobs.job(parkedId))?.status).toBe('parked');
    await agentJobProvider.jobs.claimInterruptedJobs(2);
    const exhausted = await agentJobProvider.jobs.claimInterruptedJobs(2);
    expect(exhausted.exhausted.map(job => job.jobId)).toContain(hiddenId);
    expect((await agentJobProvider.jobs.job(hiddenId))?.status).toBe('failed');
  });

  it('stops a manager and every open descendant idempotently without changing terminal rows', async() => {
    // risk: stopped managers leave workers producing irreversible side effects
    const root = await registry.createJob([{ agentId: 'manager', label: 'manager', prompt: 'x', status: 'running', threadId: 'manager-thread' }]);
    const child = await registry.createJob([{ agentId: 'worker', label: 'worker', prompt: 'x', status: 'running', threadId: 'worker-thread' }], 'manager', 'manager-thread');
    const grandchild = await registry.createJob([{ agentId: 'sub', label: 'sub', prompt: 'x', status: 'running', threadId: 'sub-thread' }], 'worker', 'worker-thread');
    expect(await registry.stopJobCascade(root.jobId)).toBe('stopped');
    expect((await registry.getJob(child.jobId))?.status).toBe('stopped');
    expect((await registry.getJob(grandchild.jobId))?.status).toBe('stopped');
    expect(await registry.stopJobCascade(root.jobId)).toBe('already-finished');
  });
  it('acknowledges completion delivery once even when retried', async() => {
    // risk: duplicate irreversible side effect
    const job = await registry.createJob(0, 'parent', 'parent-thread');
    await registry.completeJob(job.jobId, []);
    await registry.markCompletionDelivered(job.jobId);
    const deliveredAt = (await registry.getJob(job.jobId))?.completionDeliveredAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    await registry.markCompletionDelivered(job.jobId);
    expect((await registry.getJob(job.jobId))?.completionDeliveredAt).toBe(deliveredAt);
    expect((await registry.getPendingCompletions()).some(item => item.jobId === job.jobId)).toBe(false);
  });
  it('evicts only settled cache entries and rehydrates them from Postgres on demand', async() => {
    // risk: cache bounding deletes durable history or drops live and parked work
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const settled = await registry.createJob(0);
    await registry.completeJob(settled.jobId, []);
    const running = await registry.createJob(0);
    const parked = await registry.createJob([{ agentId: 'worker', label: 'parked', prompt: 'work', status: 'running' }]);

    expect(agentJobProvider.runtime.evictSettledTerminalJobs(0)).toContain(settled.jobId);
    expect(agentJobProvider.runtime.jobs.has(running.jobId)).toBe(true);
    parked.status = 'completed';
    parked.finishedAt = Date.now();
    expect(agentJobProvider.runtime.evictSettledTerminalJobs(0)).not.toContain(parked.jobId);
    expect(agentJobProvider.runtime.jobs.has(parked.jobId)).toBe(true);
    expect((await registry.getJob(settled.jobId))?.status).toBe('completed');
  });

  it('notifies the terminal observer on every task thread the instant a job turns terminal, however it ends', async() => {
    // risk: a hidden job's heartbeat keeps firing after it returns, is stopped, or fails —
    // AgentJobService.terminalObserver is JobHeartbeatCleanup's real production trigger
    // (see JobHeartbeatCleanup.ts), so this exercises the actual cleanup seam, from every
    // entry point, instead of a caller-specific wrapper a direct service call could bypass.
    const threadsNotifiedFor = (jobId: string) => terminalNotifications.filter(job => job.jobId === jobId).flatMap(job => job.tasks.map(task => task.threadId));

    const completed = await registry.createJob([{ agentId: 'worker', label: 'c', prompt: 'x', status: 'running', threadId: 'thread-complete' }]);
    await registry.completeJob(completed.jobId, [{ label: 'c', status: 'completed', output: 'done', threadId: 'thread-complete' }]);
    expect(threadsNotifiedFor(completed.jobId)).toEqual(expect.arrayContaining(['thread-complete']));

    const failed = await registry.createJob([{ agentId: 'worker', label: 'f', prompt: 'x', status: 'running', threadId: 'thread-fail' }]);
    await registry.failJob(failed.jobId, 'boom');
    expect(threadsNotifiedFor(failed.jobId)).toEqual(expect.arrayContaining(['thread-fail']));

    const stopped = await registry.createJob([{ agentId: 'worker', label: 's', prompt: 'x', status: 'running', threadId: 'thread-stop' }]);
    expect(registry.abortJob(stopped.jobId)).toBe('stopped');
    expect(threadsNotifiedFor(stopped.jobId)).toEqual(expect.arrayContaining(['thread-stop']));

    const root = await registry.createJob([{ agentId: 'manager', label: 'r', prompt: 'x', status: 'running', threadId: 'thread-cascade-root' }]);
    const child = await registry.createJob([{ agentId: 'worker', label: 'ch', prompt: 'x', status: 'running', threadId: 'thread-cascade-child' }], 'manager', 'thread-cascade-root');
    await registry.stopJobCascade(root.jobId);
    expect([...threadsNotifiedFor(root.jobId), ...threadsNotifiedFor(child.jobId)]).toEqual(expect.arrayContaining(['thread-cascade-root', 'thread-cascade-child']));
  });
});
