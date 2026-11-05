// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';
import { ReportProgressWorker } from '../../../tools/agents/report_progress';
import { sendJobMessage } from '../../../tools/agents/send_job_message';
import { ReturnResultWorker } from '../../../tools/agents/return_result';
import { CheckAgentJobsWorker } from '../../../tools/agents/check_agent_jobs';
import { buildSubagentDirectoryContext } from '../../../services/SubagentDirectory';

const { wakeParkedAgent } = vi.hoisted(() => ({ wakeParkedAgent: vi.fn(async() => undefined) }));
vi.mock('../../../services/BackendGraphWebSocketService', () => ({
  getBackendGraphWebSocketService: () => ({ wakeParkedAgent }),
}));

class CheckAgentJobsHarness extends CheckAgentJobsWorker {
  runHarness(input: unknown) { return this._validatedCall(input); }
}

class ReturnResultHarness extends ReturnResultWorker {
  runHarness(threadId: string, input: unknown) {
    this.setState({ metadata: { threadId } } as any);
    return this._validatedCall(input);
  }
}

class ReportProgressHarness extends ReportProgressWorker {
  runHarness(threadId: string, input: unknown) {
    this.setState({ metadata: { threadId } } as any);
    return this._validatedCall(input);
  }
}

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('parked manager wake, replay and restart lifecycle (real Postgres)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let messaging: typeof import('../../../database/models/AgentJobMessagingModel');
  let jobDelivery: typeof import('../../../tools/agents/jobDelivery');
  let inbox: typeof import('../../../services/AgentCompletionInbox');
  let recovery: typeof import('../../../services/AgentCompletionRecoveryService');
  let ParkedAgentRehydrator: typeof import('../../../services/ParkedAgentRehydrator').ParkedAgentRehydrator;
  let InterruptedAgentRecoveryService: typeof import('../../../services/InterruptedAgentRecoveryService').InterruptedAgentRecoveryService;
  let agentJobProvider: typeof import('../../../app/Providers/AgentJobServiceProvider').agentJobProvider;

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    await database.applyMigrations();
    registry = await import('../../../tools/agents/jobRegistry');
    messaging = await import('../../../database/models/AgentJobMessagingModel');
    jobDelivery = await import('../../../tools/agents/jobDelivery');
    inbox = await import('../../../services/AgentCompletionInbox');
    recovery = await import('../../../services/AgentCompletionRecoveryService');
    ParkedAgentRehydrator = (await import('../../../services/ParkedAgentRehydrator')).ParkedAgentRehydrator;
    InterruptedAgentRecoveryService = (await import('../../../services/InterruptedAgentRecoveryService')).InterruptedAgentRecoveryService;
    agentJobProvider = (await import('../../../app/Providers/AgentJobServiceProvider')).agentJobProvider;
  }, 60_000);
  afterAll(async() => database.dispose());
  afterEach(() => { inbox.clearCompletionInboxes(); wakeParkedAgent.mockClear() });

  // Known-good agent identities: resolve() refuses to rehydrate an agent it
  // cannot find a definition for, so the test double only needs to answer
  // for the two slugs these scenarios use.
  const definitions = { findBySlug: async(slug: string) => (['coding-manager-sol', 'codex-sol-worker'].includes(slug) ? { slug } : null) };

  it('a) wakes a parked manager as itself when its child\'s contract returns', async() => {
    // risk: a completion wakes the wrong agent, or rehydrates the manager under the default persona instead of its own identity
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: 'wake-a-manager-thread', depth: 1 }],
      'sulla-desktop', 'wake-a-root-thread',
    );
    await registry.parkJobTask(manager.jobId, 0, 1);
    const child = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'worker', prompt: 'build', status: 'running', threadId: 'wake-a-worker-thread', depth: 2 }],
      'coding-manager-sol', 'wake-a-manager-thread',
    );

    // The child returns its contract — the exact sequence return_result.ts runs.
    await registry.recordTaskReturn(child.jobId, 0, { result: { done: true }, status: 'completed' });
    const completed = (await registry.getJob(child.jobId))!;
    const results = [{ label: 'worker', status: 'completed' as const, output: 'built', threadId: 'wake-a-worker-thread' }];
    await registry.completeJob(child.jobId, results);
    const delivered = await jobDelivery.deliverJobCompletion(completed, results);
    expect(delivered).toBe(true);

    // Resolve who owns that thread with the real, Postgres-backed rehydrator —
    // the only stand-in is the static agent-definition lookup.
    const rehydrator = new ParkedAgentRehydrator(agentJobProvider.jobs, definitions, registry.failJob, () => {});
    const identity = await rehydrator.resolve('wake-a-manager-thread');
    expect(identity).toMatchObject({ agentId: 'coding-manager-sol', taskIndex: 0 });
    expect(identity?.job.jobId).toBe(manager.jobId);

    // The completion is queued under the manager's OWN identity (its agentId
    // as channel, its own threadId) — it wakes the manager as itself, not a
    // different default agent.
    const queued = inbox.takeAgentCompletions('coding-manager-sol', 'wake-a-manager-thread');
    expect(queued).toHaveLength(1);
    expect(queued[0].jobId).toBe(child.jobId);
  });

  it('b) delivers a completion wake exactly once, and redelivers once if the turn never consumed it', async() => {
    // risk: a crash before the graph turn runs loses the completion forever, or a replay sweep double-delivers it
    const job = await registry.createJob(
      [{ agentId: 'worker', label: 'replay', prompt: 'work', status: 'running' }],
      'replay-parent', 'replay-parent-thread',
    );
    const results = [{ label: 'replay', status: 'completed' as const, output: 'done', threadId: '' }];
    await registry.completeJob(job.jobId, results);
    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(job.jobId) as any, results)).toBe(true);
    expect((await registry.getPendingCompletions()).map(j => j.jobId)).toContain(job.jobId);

    // The turn takes the batch off the live inbox but then crashes before
    // reaching dispatchToAgent's finally block — turnConsumedInput never
    // becomes true, so the durable row is deliberately left un-acked.
    expect(inbox.takeAgentCompletions('replay-parent', 'replay-parent-thread').map(e => e.jobId)).toContain(job.jobId);
    expect((await registry.getPendingCompletions()).map(j => j.jobId)).toContain(job.jobId);

    // A boot-time replay sweep must redeliver it — once.
    await recovery.recoverPendingAgentCompletions();
    const redelivered = inbox.takeAgentCompletions('replay-parent', 'replay-parent-thread');
    expect(redelivered.map(e => e.jobId)).toContain(job.jobId);

    // This time the turn runs to completion — dispatchToAgent's finally block
    // acks it, exactly like markCompletionDelivered() does for turnConsumedInput===true.
    await registry.markCompletionDelivered(job.jobId);
    await registry.markCompletionDelivered(job.jobId);
    expect((await registry.getPendingCompletions()).map(j => j.jobId)).not.toContain(job.jobId);

    // A later replay sweep must not resurrect an already-consumed completion.
    await recovery.recoverPendingAgentCompletions();
    expect(inbox.takeAgentCompletions('replay-parent', 'replay-parent-thread')).toEqual([]);
  });

  it('c) send_job_message wakes a parked manager without acking before consumption, then its progress and return stay on the same job and wake its parent', async() => {
    // risk: the ack fires at injection time (before the woken turn ran), losing or duplicating the orchestrator instruction
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: 'wake-c-manager-thread', depth: 1 }],
      'sulla-desktop', 'wake-c-root-thread',
    );
    await registry.parkJobTask(manager.jobId, 0, 1);

    const response = await sendJobMessage({ jobId: manager.jobId, message: 'continue the same goal' });
    expect(response.successBoolean).toBe(true);
    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'wake-c-manager-thread', 'continue the same goal', 'coding-manager-sol', expect.objectContaining({ jobId: manager.jobId, taskIndex: 0 }));

    // send_job_message must NOT have acked yet — only dispatchToAgent's
    // finally block does, once the woken turn actually ran.
    const pending = await messaging.AgentJobMessagingModel.pendingMessagesForThread('wake-c-manager-thread');
    expect(pending).toHaveLength(1);

    // Simulate the woken turn succeeding — the exact call dispatchToAgent's
    // finally block makes once turnConsumedInput is true.
    await messaging.AgentJobMessagingModel.markMessagesDelivered([pending[0].id], 'wake-c-manager-thread');
    expect(await messaging.AgentJobMessagingModel.pendingMessagesForThread('wake-c-manager-thread')).toEqual([]);

    // The woken manager's own report_progress and return_result land on the
    // SAME job/task — rehydration didn't fork a second job for this thread.
    const progressWorker = new ReportProgressHarness();
    const progress = JSON.parse((await progressWorker.runHarness('wake-c-manager-thread', { step: 'woken', summary: 'resumed after wake' })).responseString!);
    expect(progress.jobId).toBe(manager.jobId);
    expect(progress.taskIndex).toBe(0);

    await registry.recordTaskReturn(manager.jobId, 0, { result: { answer: 1 }, status: 'completed' });
    const results = [{ label: 'manager', status: 'completed' as const, output: 'epic done', threadId: 'wake-c-manager-thread' }];
    await registry.completeJob(manager.jobId, results);
    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(manager.jobId) as any, results)).toBe(true);
    expect(inbox.takeAgentCompletions('sulla-desktop', 'wake-c-root-thread').map(e => e.jobId)).toContain(manager.jobId);
  });

  it('d) a simulated restart resumes the running worker (not failed), never resurrects terminal jobs, and the worker\'s later contract still wakes the parked manager', async() => {
    // risk: restart recovery marks a live worker failed, or resurrects a job that already finished
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: 'restart-d-manager-thread', depth: 1 }],
      'sulla-desktop', 'restart-d-root-thread',
    );
    await registry.parkJobTask(manager.jobId, 0, 1);
    const worker = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'worker', prompt: 'build', status: 'running', threadId: 'restart-d-worker-thread', depth: 2 }],
      'coding-manager-sol', 'restart-d-manager-thread',
    );
    const terminal = await registry.createJob(
      [{ agentId: 'worker', label: 'done-already', prompt: 'work', status: 'running' }],
      'someone', 'restart-d-terminal-thread',
    );
    await registry.completeJob(terminal.jobId, [{ label: 'done-already', status: 'completed', output: 'ok', threadId: '' }]);
    await registry.markCompletionDelivered(terminal.jobId);

    // A fresh recovery service bound straight to the repository models a cold
    // restart: no hot cache, no in-memory waiters, Postgres is the only truth.
    const resumed: Array<{ jobId: string; taskIndex: number }> = [];
    const failed: string[] = [];
    const bootRecovery = new InterruptedAgentRecoveryService(
      agentJobProvider.jobs,
      async(job, taskIndex) => { resumed.push({ jobId: job.jobId, taskIndex }) },
      (job) => { failed.push(job.jobId) },
      2,
    );
    await bootRecovery.recover();

    expect(resumed.map(r => r.jobId)).toContain(worker.jobId);
    expect(failed).toEqual([]);
    const workerRow = await agentJobProvider.jobs.job(worker.jobId);
    expect(workerRow).toMatchObject({ status: 'running', restartResumeCount: 1 });
    const managerRow = await agentJobProvider.jobs.job(manager.jobId);
    expect(managerRow?.status).toBe('parked');
    const terminalRow = await agentJobProvider.jobs.job(terminal.jobId);
    expect(terminalRow?.status).toBe('completed');

    // A second restart sweep must not touch the parked manager and must not
    // re-fail or re-resume a job it already handled unless still running.
    await bootRecovery.recover();
    expect((await agentJobProvider.jobs.job(manager.jobId))?.status).toBe('parked');

    // The resumed worker now finishes — its contract must still wake the
    // SAME parked manager thread, proving restart never lost that linkage.
    await registry.recordTaskReturn(worker.jobId, 0, { result: { built: true }, status: 'completed' });
    const results = [{ label: 'worker', status: 'completed' as const, output: 'built', threadId: 'restart-d-worker-thread' }];
    await registry.completeJob(worker.jobId, results);
    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(worker.jobId) as any, results)).toBe(true);
    expect(inbox.takeAgentCompletions('coding-manager-sol', 'restart-d-manager-thread').map(e => e.jobId)).toContain(worker.jobId);
  });

  it('e) a stale wake target does not abort send_job_message, and the other task is still woken', async() => {
    // risk: wakeParkedAgent throwing for one target (job finished/stopped, or
    // its agent definition went missing, between targetsForJob and the wake)
    // aborts the whole tool call, stranding the message queued for every
    // other target in the same send_job_message call
    const manager = await registry.createJob(
      [
        { agentId: 'coding-manager-sol', label: 'manager-a', prompt: 'epic a', status: 'running', threadId: 'wake-e-thread-a', depth: 1 },
        { agentId: 'coding-manager-sol', label: 'manager-b', prompt: 'epic b', status: 'parked', threadId: 'wake-e-thread-b', depth: 1 },
      ],
      'sulla-desktop', 'wake-e-root-thread',
    );
    // parkJobTask flips job.status and task 0's status together; task 1 was
    // already created 'parked' above so both read as parked task targets.
    await registry.parkJobTask(manager.jobId, 0, 1);

    wakeParkedAgent.mockImplementation((async(_channel: string, threadId: string) => {
      if (threadId === 'wake-e-thread-a') throw new Error(`Thread ${ threadId } is not a parked agent job.`);
      return true;
    }) as any);

    const response = await sendJobMessage({ jobId: manager.jobId, message: 'continue the same goal' });

    expect(response.successBoolean).toBe(true);
    const parsed = JSON.parse(response.responseString!);
    expect(parsed.deliveredLive).toBe(1);
    expect(parsed.notWoken).toEqual([{ taskIndex: 0, reason: expect.stringContaining('not a parked agent job') }]);
    expect(wakeParkedAgent).toHaveBeenCalledTimes(2);
    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'wake-e-thread-b', 'continue the same goal', 'coding-manager-sol', expect.objectContaining({ taskIndex: 1 }));

    // The failed target's message is untouched — still pending, job not
    // resurrected or otherwise mutated by the failure.
    expect(await messaging.AgentJobMessagingModel.pendingMessagesForThread('wake-e-thread-a')).toHaveLength(1);
    expect((await registry.getJob(manager.jobId))?.status).toBe('parked');

    wakeParkedAgent.mockImplementation(async() => undefined);
  });

  it('f) a multi-task job keeps its still-running sibling claimable for restart recovery even after another task in the same job parks', async() => {
    // risk: parkJobTask flipping the WHOLE job to 'parked' hides a sibling task's own job from claimInterruptedJobs, so a genuinely orphaned run never resumes after a restart
    const job = await registry.createJob(
      [
        { agentId: 'codex-sol-worker', label: 'worker-sibling', prompt: 'build', status: 'running', threadId: 'multi-f-worker-thread', depth: 1 },
        { agentId: 'coding-manager-sol', label: 'manager-sibling', prompt: 'own epic', status: 'running', threadId: 'multi-f-manager-thread', depth: 1 },
      ],
      'sulla-desktop', 'multi-f-root-thread',
    );
    await registry.parkJobTask(job.jobId, 1, 0);

    // Job-level status is a rollup: the still-running sibling keeps it 'running'.
    const parked = await agentJobProvider.jobs.job(job.jobId);
    expect(parked?.status).toBe('running');
    expect(parked?.tasks[0].status).toBe('running');
    expect(parked?.tasks[1].status).toBe('parked');

    // A fresh recovery service bound straight to the repository models a cold restart.
    const resumed: Array<{ jobId: string; taskIndex: number }> = [];
    const bootRecovery = new InterruptedAgentRecoveryService(
      agentJobProvider.jobs,
      async(resumedJob, taskIndex) => { resumed.push({ jobId: resumedJob.jobId, taskIndex }) },
      () => {},
      2,
    );
    await bootRecovery.recover();

    // Only the still-running sibling is reclaimed; the parked manager task is left alone.
    expect(resumed).toEqual([{ jobId: job.jobId, taskIndex: 0 }]);
    const afterRecovery = await agentJobProvider.jobs.job(job.jobId);
    expect(afterRecovery?.tasks[1].status).toBe('parked');
    expect(afterRecovery?.restartResumeCount).toBe(1);
  });

  it('g) a parked manager sharing its job with a running sibling is still found and woken by its own child worker\'s contract', async() => {
    // risk: resolve() gates rehydration on the job-level rollup status, so a running sibling keeps the job 'running' and the manager's own individually-parked task is never recognised as dormant
    const manager = await registry.createJob(
      [
        { agentId: 'codex-sol-worker', label: 'worker-sibling', prompt: 'build', status: 'running', threadId: 'multi-g-worker-sibling-thread', depth: 1 },
        { agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: 'multi-g-manager-thread', depth: 1 },
      ],
      'sulla-desktop', 'multi-g-root-thread',
    );
    await registry.parkJobTask(manager.jobId, 1, 1);
    expect((await agentJobProvider.jobs.job(manager.jobId))?.status).toBe('running');

    const child = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'worker', prompt: 'build', status: 'running', threadId: 'multi-g-child-thread', depth: 2 }],
      'coding-manager-sol', 'multi-g-manager-thread',
    );

    // The task-level rehydrator must find the manager's own task as parked,
    // independent of the job's rollup status staying 'running'.
    const rehydrator = new ParkedAgentRehydrator(agentJobProvider.jobs, definitions, registry.failJob, () => {});
    const identity = await rehydrator.resolve('multi-g-manager-thread');
    expect(identity).toMatchObject({ agentId: 'coding-manager-sol', taskIndex: 1 });
    expect(identity?.job.jobId).toBe(manager.jobId);

    // The child's contract return must wake that exact manager thread.
    await registry.recordTaskReturn(child.jobId, 0, { result: { done: true }, status: 'completed' });
    const results = [{ label: 'worker', status: 'completed' as const, output: 'built', threadId: 'multi-g-child-thread' }];
    await registry.completeJob(child.jobId, results);
    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(child.jobId) as any, results)).toBe(true);
    expect(inbox.takeAgentCompletions('coding-manager-sol', 'multi-g-manager-thread').map(e => e.jobId)).toContain(child.jobId);
  });

  it('h) a completed, stopped, or failed job is never reclaimed by restart recovery', async() => {
    // risk: restart recovery resurrects settled work and re-dispatches a duplicate, irreversible side effect
    const completed = await registry.createJob([{ agentId: 'worker', label: 'done', prompt: 'x', status: 'running', threadId: 'terminal-h-completed-thread' }]);
    await registry.completeJob(completed.jobId, [{ label: 'done', status: 'completed', output: 'ok', threadId: 'terminal-h-completed-thread' }]);
    const stopped = await registry.createJob([{ agentId: 'worker', label: 'stopped', prompt: 'x', status: 'running', threadId: 'terminal-h-stopped-thread' }]);
    registry.abortJob(stopped.jobId);
    await registry.completeJob(stopped.jobId, []);
    const failed = await registry.createJob([{ agentId: 'worker', label: 'failed', prompt: 'x', status: 'running', threadId: 'terminal-h-failed-thread' }]);
    await registry.failJob(failed.jobId, 'boom');

    const resumed: string[] = [];
    const bootRecovery = new InterruptedAgentRecoveryService(
      agentJobProvider.jobs,
      async(resumedJob) => { resumed.push(resumedJob.jobId) },
      () => {},
      2,
    );
    await bootRecovery.recover();

    expect(resumed).not.toContain(completed.jobId);
    expect(resumed).not.toContain(stopped.jobId);
    expect(resumed).not.toContain(failed.jobId);
    expect((await agentJobProvider.jobs.job(completed.jobId))?.status).toBe('completed');
    expect((await agentJobProvider.jobs.job(stopped.jobId))?.status).toBe('stopped');
    expect((await agentJobProvider.jobs.job(failed.jobId))?.status).toBe('failed');
  });
  it('i) refuses a manager contract while queued, running, or parked children remain', async() => {
    // risk: accepting a manager's final contract while it still owns live
    // children makes its thread terminal, so their later results can never
    // wake the manager that is responsible for integrating them.
    const managerThreadId = 'return-i-manager-thread';
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: managerThreadId, depth: 1 }],
      'sulla-desktop', 'return-i-root-thread',
    );
    const firstChild = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'worker-a', prompt: 'build a', status: 'running', threadId: 'return-i-child-a', depth: 2 }],
      'coding-manager-sol', managerThreadId,
    );
    const secondChild = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'worker-b', prompt: 'build b', status: 'parked', threadId: 'return-i-child-b', depth: 2 }],
      'coding-manager-sol', managerThreadId,
    );

    const worker = new ReturnResultHarness();
    const refused = await worker.runHarness(managerThreadId, { status: 'completed', summary: 'PARKED', output: {} });

    expect(refused).toEqual({
      successBoolean: false,
      responseString: 'you have 2 running children; park by ending your turn, or stop them first',
    });
    expect((await registry.getJob(manager.jobId))?.tasks[0].returnedAt).toBeUndefined();

    await registry.completeJob(firstChild.jobId, [{ label: 'worker-a', status: 'completed', output: 'done', threadId: 'return-i-child-a' }]);
    registry.abortJob(secondChild.jobId);
    const accepted = await worker.runHarness(managerThreadId, { status: 'completed', summary: 'done', output: {} });
    expect(accepted.successBoolean).toBe(true);
  });

  it('j) redirects a late child result to the finished manager parent without resurrecting the manager', async() => {
    // risk: a child settling after its manager finished either silently drops
    // its result or wakes the terminal manager and duplicates its final turn.
    const managerThreadId = 'orphan-j-manager-thread';
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: managerThreadId, depth: 1 }],
      'sulla-desktop', 'orphan-j-root-thread',
    );
    const child = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'late worker', prompt: 'build', status: 'running', threadId: 'orphan-j-child-thread', depth: 2 }],
      'coding-manager-sol', managerThreadId,
    );
    await registry.completeJob(manager.jobId, [{ label: 'manager', status: 'completed', output: 'finished early', threadId: managerThreadId }]);

    const results = [{ label: 'late worker', status: 'completed' as const, output: 'late result', threadId: 'orphan-j-child-thread' }];
    await registry.completeJob(child.jobId, results);
    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(child.jobId) as any, results)).toBe(true);

    expect((await registry.getJob(manager.jobId))?.status).toBe('completed');
    expect(inbox.takeAgentCompletions('coding-manager-sol', managerThreadId)).toEqual([]);
    const rootNotices = inbox.takeAgentCompletions('sulla-desktop', 'orphan-j-root-thread');
    expect(rootNotices).toHaveLength(1);
    expect(rootNotices[0]).toMatchObject({ jobId: child.jobId, failureReason: expect.stringContaining('orphaned child result') });
    const durableManager = await agentJobProvider.jobs.job(manager.jobId);
    expect(durableManager?.orphanedChildNotices).toEqual([
      expect.objectContaining({ childJobId: child.jobId, taskIndex: 0, managerStatus: 'completed', results }),
    ]);

    // Recovery/retry is idempotent: no duplicate durable notice and no second
    // manager turn is ever eligible for rehydration.
    await jobDelivery.deliverJobCompletion(await registry.getJob(child.jobId) as any, results);
    expect((await agentJobProvider.jobs.job(manager.jobId))?.orphanedChildNotices).toHaveLength(1);
  });

  it('k) records a late child result durably when the finished manager is a top-level chat', async() => {
    // risk: there is no higher parent to notify, so a late result disappears
    // unless check_agent_jobs can surface a durable notice on the manager job.
    const managerThreadId = 'orphan-k-top-level-thread';
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'top manager', prompt: 'own epic', status: 'running', threadId: managerThreadId, depth: 1 }],
      'sulla-desktop', undefined,
    );
    const child = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'late worker', prompt: 'build', status: 'running', threadId: 'orphan-k-child-thread', depth: 2 }],
      'coding-manager-sol', managerThreadId,
    );
    await registry.completeJob(manager.jobId, [{ label: 'top manager', status: 'completed', output: 'done', threadId: managerThreadId }]);
    const results = [{ label: 'late worker', status: 'error' as const, output: 'failed late', threadId: 'orphan-k-child-thread' }];
    await registry.completeJob(child.jobId, results);

    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(child.jobId) as any, results)).toBe(true);
    expect(inbox.takeAgentCompletions('coding-manager-sol', managerThreadId)).toEqual([]);
    expect((await agentJobProvider.jobs.job(manager.jobId))?.orphanedChildNotices).toEqual([
      expect.objectContaining({ childJobId: child.jobId, managerStatus: 'completed', results }),
    ]);
  });

  it('l) exposes parked status and child count in both parent inspection surfaces', async() => {
    // risk: a healthy parked manager looks completed or dead to its parent,
    // causing an unnecessary relaunch and duplicate ownership of the epic.
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: 'view-l-manager-thread', depth: 1 }],
      'sulla-desktop', 'view-l-root-thread',
    );
    await registry.parkJobTask(manager.jobId, 0, 2);

    const check = new CheckAgentJobsHarness();
    const detail = JSON.parse((await check.runHarness({ jobId: manager.jobId })).responseString!);
    expect(detail).toMatchObject({ status: 'parked', waitingOnChildren: 2, tasks: [{ status: 'parked' }] });
    expect(await buildSubagentDirectoryContext('view-l-root-thread')).toContain('parked, waiting on 2 children');
  });

  it('m) wakes a parked manager with a failed child contract instead of silently dropping it', async() => {
    // risk: only successful child contracts wake the manager, leaving failed
    // work invisible and the fleet parked forever.
    const managerThreadId = 'failure-m-manager-thread';
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: managerThreadId, depth: 1 }],
      'sulla-desktop', 'failure-m-root-thread',
    );
    await registry.parkJobTask(manager.jobId, 0, 1);
    const child = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'failed worker', prompt: 'build', status: 'running', threadId: 'failure-m-child-thread', depth: 2 }],
      'coding-manager-sol', managerThreadId,
    );
    const results = [{ label: 'failed worker', status: 'error' as const, output: 'provider failed', threadId: 'failure-m-child-thread' }];
    await registry.completeJob(child.jobId, results);

    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(child.jobId) as any, results)).toBe(true);
    expect(inbox.takeAgentCompletions('coding-manager-sol', managerThreadId)).toEqual([
      expect.objectContaining({ jobId: child.jobId, results, failureReason: undefined }),
    ]);
    expect((await registry.getJob(manager.jobId))?.status).toBe('parked');
  });

});
