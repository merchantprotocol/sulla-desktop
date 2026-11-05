// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StopPrincipal } from '../../app/ValueObjects/StopPrincipal';
import { StopAgentJobWorker } from '../../tools/agents/stop_agent_job';
import { TestDatabase } from '../Support/TestDatabase';
const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;
class StopAgentJobHarness extends StopAgentJobWorker {
  runValidated(state: any, input: unknown) { this.setState(state); return this._validatedCall(input); }
}
dbDescribe('AgentJobService state machine with real Postgres', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../tools/agents/jobRegistry');
  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    registry = await import('../../tools/agents/jobRegistry');
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
    expect(registry.abortJob(stopped.jobId, StopPrincipal.human(), 'test stop')).toBe('stopped');
    await registry.completeJob(stopped.jobId, []);
    expect((await registry.getJob(stopped.jobId))?.status).toBe('stopped');
    expect(registry.abortJob(stopped.jobId, StopPrincipal.human(), 'test stop')).toBe('already-finished');
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
    expect(await registry.stopJobCascade(root.jobId, StopPrincipal.human(), 'test stop')).toBe('stopped');
    expect((await registry.getJob(child.jobId))?.status).toBe('stopped');
    expect((await registry.getJob(grandchild.jobId))?.status).toBe('stopped');
    expect((await registry.getJob(child.jobId))?.stoppedBy).toBe('human');
    expect((await registry.getJob(child.jobId))?.stopReason).toBe('test stop');
    expect((await registry.getJob(grandchild.jobId))?.stoppedBy).toBe('human');
    expect((await registry.getJob(grandchild.jobId))?.stopReason).toBe('test stop');
    expect(await registry.stopJobCascade(root.jobId, StopPrincipal.human(), 'test stop')).toBe('already-finished');
  });
  it('stops one task without aborting its sibling and settles the job only after all tasks stop', async() => {
    // risk: lifecycle isolation — a targeted stop must not kill unrelated sibling work.
    const job = await registry.createJob([
      { agentId: 'worker', label: 'first', prompt: 'x', status: 'running', threadId: 'first-thread' },
      { agentId: 'worker', label: 'second', prompt: 'x', status: 'running', threadId: 'second-thread' },
    ]);
    const firstSignal = registry.getTaskAbortSignal(job.jobId, 0)!;
    const secondSignal = registry.getTaskAbortSignal(job.jobId, 1)!;
    expect(await registry.stopJobTask(job.jobId, 0, StopPrincipal.human(), 'targeted stop')).toBe('stopped');
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect((await registry.getJob(job.jobId))?.status).toBe('running');
    expect((await registry.getJob(job.jobId))?.tasks.map(task => task.status)).toEqual(['stopped', 'running']);
    expect(await registry.stopJobTask(job.jobId, 1, StopPrincipal.human(), 'targeted stop')).toBe('stopped');
    expect((await registry.getJob(job.jobId))?.status).toBe('stopped');
  });
  it('settles a task stopped mid-turn with honest persisted output while its sibling keeps running', async() => {
    // risk: lifecycle isolation — an intentional stop must not become a false missing-contract failure.
    const job = await registry.createJob([
      { agentId: 'worker', label: 'unaffected', prompt: 'keep working', status: 'running', threadId: 'unaffected-thread' },
      { agentId: 'worker', label: 'stopped', prompt: 'mid-turn work', status: 'running', threadId: 'stopped-thread' },
    ]);
    expect(await registry.stopJobTask(job.jobId, 1, StopPrincipal.system('WrapUpGraceExpiry'), 'acceptance: hard stop one task')).toBe('stopped');

    const result = await registry.stoppedTaskResult(job.jobId, 1, 'stopped', 'stopped-thread');
    expect(result).toMatchObject({
      status: 'stopped',
      output: 'stopped by WrapUpGraceExpiry: acceptance: hard stop one task',
      threadId: 'stopped-thread',
      contract: 'result',
    });
    expect(result?.output).not.toContain('missing_contract');
    await registry.recordTaskCompletion(job.jobId, 1, result!);

    const { AgentJobRepository } = await import('../../app/Repositories/AgentJobRepository');
    const { DesktopPostgresConnection } = await import('../../app/Database/DesktopPostgresConnection');
    const { postgresClient } = await import('../../database/PostgresClient');
    const persisted = await new AgentJobRepository(new DesktopPostgresConnection(postgresClient)).job(job.jobId);
    expect(persisted?.status).toBe('running');
    expect(persisted?.tasks[0].status).toBe('running');
    expect(persisted?.tasks[1].status).toBe('stopped');
    expect(persisted?.tasks[1].completion).toMatchObject(result!);
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
  it('authorizes only owner and ancestor threads and persists stop attribution across repository reloads', async() => {
    // risk: authorization — a sibling using the same agent definition must never stop another owner's job.
    const ancestor = await registry.createJob([{ agentId: 'manager', label: 'parent', prompt: 'x', status: 'running', threadId: 'parent-thread' }], 'root', 'grandparent-thread');
    const siblingTarget = await registry.createJob([{ agentId: 'codex-sol-worker', label: 'target', prompt: 'x', status: 'running', threadId: 'target-thread' }], 'manager', 'parent-thread', { parentAgentId: 'codex-sol-worker' });
    expect(await registry.stopJobCascade(siblingTarget.jobId, StopPrincipal.agent('codex-sol-worker', 'sibling-thread')!, 'foreign stop')).toBe('forbidden');
    expect((await registry.getJob(siblingTarget.jobId))?.status).toBe('running');
    expect(await registry.stopJobCascade(siblingTarget.jobId, StopPrincipal.agent('manager', 'parent-thread')!, 'parent requested')).toBe('stopped');
    const { AgentJobRepository } = await import('../../app/Repositories/AgentJobRepository');
    const { DesktopPostgresConnection } = await import('../../app/Database/DesktopPostgresConnection');
    const { postgresClient } = await import('../../database/PostgresClient');
    const reloaded = await new AgentJobRepository(new DesktopPostgresConnection(postgresClient)).job(siblingTarget.jobId);
    expect(reloaded?.stoppedBy).toEqual({ agentId: 'manager', threadId: 'parent-thread' });
    expect(reloaded?.stopReason).toBe('parent requested');

    const grandchild = await registry.createJob([{ agentId: 'worker', label: 'grandchild', prompt: 'x', status: 'running', threadId: 'grandchild-thread' }], 'manager', 'parent-thread');
    expect(await registry.stopJobCascade(grandchild.jobId, StopPrincipal.agent('root', 'grandparent-thread')!, 'grandparent requested')).toBe('stopped');
    expect((await registry.getJob(grandchild.jobId))?.stoppedBy).toEqual({ agentId: 'root', threadId: 'grandparent-thread' });
    expect(ancestor.status).toBe('running');
  });

  it('records explicit human and system stop principals', async() => {
    // risk: auditability — automatic reapers must not be recorded as a human action.
    const humanJob = await registry.createJob(0);
    registry.abortJob(humanJob.jobId, StopPrincipal.human(), 'human IPC stop');
    expect((await registry.getJob(humanJob.jobId))?.stoppedBy).toBe('human');
    const watcherJob = await registry.createJob(0);
    registry.abortJob(watcherJob.jobId, StopPrincipal.system('DeadRunWatcher'), 'dead run: no activity 30m');
    expect((await registry.getJob(watcherJob.jobId))?.stoppedBy).toEqual({ system: 'DeadRunWatcher' });
    expect((await registry.getJob(watcherJob.jobId))?.stopReason).toBe('dead run: no activity 30m');
  });

  it('refuses a worker stopping its parent and names the owner through worker metadata', async() => {
    // risk: authorization — a child can otherwise kill the manager supervising it.
    const parent = await registry.createJob([{ agentId: 'manager', label: 'manager', prompt: 'own', status: 'running', threadId: 'manager-owner-thread' }], 'sulla-desktop', 'root-owner-thread', { parentAgentId: 'sulla-desktop' });
    const worker = new StopAgentJobHarness();
    const refusal = await worker.runValidated({ metadata: { threadId: 'child-worker-thread', routedAgentId: 'codex-sol-worker' } }, { jobId: parent.jobId });
    expect(refusal.successBoolean).toBe(false);
    expect(refusal.responseString).toContain('owned by sulla-desktop');
    expect((await registry.getJob(parent.jobId))?.status).toBe('running');
  });

  it('uses a concrete agent reason when stop_agent_job omits reason', async() => {
    // risk: auditability — optional input must not persist an ambiguous placeholder.
    const child = await registry.createJob([{ agentId: 'worker', label: 'worker', prompt: 'work', status: 'running', threadId: 'reason-child-thread' }], 'manager', 'reason-owner-thread', { parentAgentId: 'manager' });
    const worker = new StopAgentJobHarness();
    const stopped = await worker.runValidated({ metadata: { threadId: 'reason-owner-thread', routedAgentId: 'manager' } }, { jobId: child.jobId });
    expect(stopped.successBoolean).toBe(true);
    expect((await registry.getJob(child.jobId))?.stopReason).toBe('agent request (no reason given)');
  });

});
