// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentJobMessagingRepository } from '../../../app/Repositories/AgentJobMessagingRepository';
import { AgentJobRepository } from '../../../app/Repositories/AgentJobRepository';
import { HumanDecisionRepository } from '../../../app/Repositories/HumanDecisionRepository';
import { PendingDecisionRepository } from '../../../repositories/PendingDecisionRepository';
import { DecisionService } from '../../../services/DecisionService';
import { DecisionHolderNotifier } from '../../../services/DecisionHolderNotifier';
import { LateDecisionAnswerHandler } from '../../../services/LateDecisionAnswerHandler';
import { BlockerDecisionPublisher } from '../../../services/BlockerDecisionPublisher';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('AgentJobMessagingRepository', () => {
  const database = new TestDatabase();
  let jobs: AgentJobRepository;
  let messages: AgentJobMessagingRepository;

  beforeAll(async() => {
    await database.initialize();
    const connection = new PostgresConnection({ query: async(sql, bindings) => {
      const rows = await database.query(sql, [...(bindings ?? [])]);
      return { rows, rowCount: rows.length };
    } });
    jobs = new AgentJobRepository(connection);
    messages = new AgentJobMessagingRepository(connection);
  }, 60_000);
  afterAll(async() => database.dispose());

  it('round-trips messages and makes delivery acknowledgement idempotent', async() => {
    // risk: duplicate delivery of parent-to-worker instructions
    await jobs.insertJob({ jobId: 'message-idempotency', status: 'running', createdAt: Date.now(),
      finishedAt: null, taskCount: 1, results: [], visibility: 'hidden',
      tasks: [{ agentId: 'worker', label: 'lane', prompt: 'work', status: 'running', threadId: 'message-thread' }] });
    const target = (await messages.targetsForJob('message-idempotency'))[0];
    const queued = await messages.queueMessage(target, 'continue', 'decision');
    expect(queued.messageKind).toBe('decision');
    expect(await messages.pendingMessagesForThread('message-thread')).toMatchObject([{ message: 'continue', messageKind: 'decision' }]);
    await messages.markMessagesDelivered([queued.id], 'message-thread');
    await database.query("UPDATE agent_job_messages SET delivered_at = TIMESTAMP '2000-01-01 00:00:00' WHERE id = $1", [queued.id]);
    const [{ delivered_at: firstDelivery }] = await database.query<{ delivered_at: Date }>('SELECT delivered_at FROM agent_job_messages WHERE id = $1', [queued.id]);
    await messages.markMessagesDelivered([queued.id], 'message-thread');
    expect(await messages.pendingMessagesForThread('message-thread')).toEqual([]);
    const [{ delivered_at: secondDelivery }] = await database.query<{ delivered_at: Date }>('SELECT delivered_at FROM agent_job_messages WHERE id = $1', [queued.id]);
    expect(secondDelivery.getTime()).toBe(firstDelivery.getTime());
  });

  it('retries a failed blocker insert on unchanged reports without duplicating answered decisions', async() => {
    // risk: orchestration liveness — a persisted check-in whose decision insert failed must retry into one answerable parent decision, while unchanged or already-answered reports must not duplicate it.
    const suffix = `blocker-${ Date.now() }`;
    const managerThread = `${ suffix }-manager`;
    const childThread = `${ suffix }-child`;
    const managerJob = `${ suffix }-manager-job`;
    const childJob = `${ suffix }-child-job`;
    await jobs.insertJob({ jobId: managerJob, status: 'running', createdAt: Date.now(), finishedAt: null, taskCount: 1,
      results: [], visibility: 'hidden', parentChannel: 'root-channel', parentThreadId: `${ suffix }-root`,
      tasks: [{ agentId: 'manager', label: 'manager', prompt: 'manage work', status: 'running', threadId: managerThread }] });
    await jobs.insertJob({ jobId: childJob, status: 'running', createdAt: Date.now(), finishedAt: null, taskCount: 1,
      results: [], visibility: 'hidden', parentChannel: 'manager-channel', parentThreadId: managerThread,
      tasks: [{ agentId: 'worker', label: 'database lane', prompt: 'work', status: 'running', threadId: childThread }] });

    const queryClient = { query: async(sql: string, params?: unknown[]) => database.query(sql, params) };
    const pending = new PendingDecisionRepository(queryClient as any);
    const decisionRecords = new HumanDecisionRepository(queryClient as any);
    const holderDeliveries: Array<{ jobId?: string; taskIndex?: number; message: string }> = [];
    const parkQuestionAsker = vi.fn(async() => false);
    const holder = new DecisionHolderNotifier({
      sendJob: async(input) => {
        holderDeliveries.push({ jobId: input.jobId, taskIndex: input.taskIndex, message: input.message });
        return { successBoolean: true, responseString: JSON.stringify({ queuedForNextBoundary: 1 }) };
      },
      enqueueChat: async(_channel, _thread, entry) => { holderDeliveries.push({ message: entry.notice }); return true; },
      canUseTool: async() => true,
      humanIsActive: async() => false,
      canSteer: async() => true,
    } as any);
    const answerer = new LateDecisionAnswerHandler(pending as any, { find: async(id: string) => ({ id }) }, { send: async() => true }, {
      send: async(jobId, taskIndex, message) => {
        const target = (await messages.targetsForJob(jobId, taskIndex))[0];
        if (!target) return false;
        await messages.queueMessage(target, message, 'decision');
        return true;
      },
    });
    const decisions = new DecisionService(answerer, {
      pendingDecisions: pending as any,
      decisions: decisionRecords as any,
      holderNotifier: holder as any,
      askerWaiter: { park: async() => undefined, parkQuestionAsker } as any,
    });
    const publisher = new BlockerDecisionPublisher(decisions);
    const blocker = 'Which schema should this migration use?';
    const childChannel = 'worker-channel';
    const report = (blockers: string[]) => messages.appendCheckin(childThread, { step: blockers.length ? 'blocked' : 'unblocked', summary: 'Worker progress', blockers });

    const first = await report([blocker]);
    expect(first?.blockersChanged).toBe(true);
    vi.spyOn(pending, 'latestBlockerForTask').mockRejectedValueOnce(new Error('transient lookup failure'));
    await expect(publisher.publish(first!, childThread, childChannel)).rejects.toThrow('transient lookup failure');
    expect(await pending.latestBlockerForTask(childJob, 0)).toBeUndefined();

    const retry = await report([blocker]);
    expect(retry?.blockersChanged).toBe(false);
    await publisher.publish(retry!, childThread, childChannel);
    const created = await pending.latestBlockerForTask(childJob, 0);
    expect(created).toMatchObject({ kind: 'question', status: 'pending', requestedBy: { jobId: childJob, taskIndex: 0, label: 'database lane' } });
    expect(created?.channel).toBe(childChannel);
    expect(created?.route?.chain[0]).toMatchObject({ threadId: managerThread, jobId: managerJob, taskIndex: 0, kind: 'agent' });
    expect(created?.route?.chain[0]?.channel).toBe('manager-channel');
    expect(holderDeliveries).toHaveLength(1);
    expect(holderDeliveries[0]).toMatchObject({ jobId: managerJob, taskIndex: 0 });
    expect(holderDeliveries[0].message).toContain(`[Decision from database lane (decision ${ created?.id })]`);
    expect(holderDeliveries[0].message).toContain(`${ childJob } task 0`);
    expect(holderDeliveries[0].message).toContain(blocker);
    expect(parkQuestionAsker).not.toHaveBeenCalled();
    expect(await decisions.openBlockerTaskKeys([childJob])).toEqual(new Set([`${ childJob }#0`]));
    const [{ count: blockerDecisionCount }] = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM human_decisions
      WHERE record->>'kind'='question' AND record#>>'{payload,blockerJobId}'=$1 AND record#>>'{payload,blockerTaskIndex}'=$2`, [childJob, '0']);
    expect(blockerDecisionCount).toBe('1');

    const repeated = await report([blocker]);
    expect(repeated?.blockersChanged).toBe(false);
    await publisher.publish(repeated!, childThread, childChannel);
    expect(holderDeliveries).toHaveLength(1);
    expect((await pending.latestBlockerForTask(childJob, 0))?.id).toBe(created?.id);

    const changed = await report(['Use the compatible migration schema instead.']);
    await publisher.publish(changed!, childThread, childChannel);
    const changedDecision = await pending.latestBlockerForTask(childJob, 0);
    expect(changedDecision?.id).not.toBe(created?.id);
    expect((await pending.findById(created!.id))?.attention).toBe('dismissed');
    expect(holderDeliveries).toHaveLength(2);

    const cleared = await report([]);
    expect(cleared?.blockersChanged).toBe(true);
    await publisher.publish(cleared!, childThread, childChannel);
    expect((await pending.latestBlockerForTask(childJob, 0))?.attention).toBe('dismissed');
    expect(await decisions.openBlockerTaskKeys([childJob])).toEqual(new Set());

    const reraised = await report([blocker]);
    await publisher.publish(reraised!, childThread, childChannel);
    const replacement = await pending.latestBlockerForTask(childJob, 0);
    expect(replacement?.id).not.toBe(changedDecision?.id);
    expect(holderDeliveries).toHaveLength(3);

    await expect(decisions.answerAsAgent(managerThread, replacement!.id, 'answer', [{ question: replacement!.questions![0].question, selected: ['Acknowledged; continue'] }]))
      .resolves.toMatchObject({ settled: true });
    const answer = (await messages.pendingMessagesForThread(childThread)).at(-1);
    expect(answer?.messageKind).toBe('decision');
    expect(answer?.message).toContain('Decision answered by manager');
    expect(await decisions.openBlockerTaskKeys([childJob])).toEqual(new Set());

    const answeredRetry = await report([blocker]);
    expect(answeredRetry?.blockersChanged).toBe(false);
    await publisher.publish(answeredRetry!, childThread, childChannel);
    expect((await pending.latestBlockerForTask(childJob, 0))?.id).toBe(replacement?.id);
    expect(holderDeliveries).toHaveLength(3);

    const finishing = await report(['A new blocker before the child returns']);
    await publisher.publish(finishing!, childThread, childChannel);
    await database.query(`UPDATE agent_jobs SET tasks=jsonb_set(tasks, '{0,status}', '"completed"') WHERE job_id=$1`, [childJob]);
    expect((await pending.latestBlockerForTask(childJob, 0))?.status).toBe('pending');
    expect(await decisions.openBlockerTaskKeys([childJob])).toEqual(new Set([`${ childJob }#0`]));
  });

  it('keeps blocker decisions task-scoped when three children publish concurrently', async() => {
    // risk: tenant/task isolation — simultaneous child blockers must not overwrite or merge decisions.
    const suffix = `parallel-blocker-${ Date.now() }`;
    const managerThread = `${ suffix }-manager`;
    const managerJob = `${ suffix }-manager-job`;
    await jobs.insertJob({ jobId: managerJob, status: 'running', createdAt: Date.now(), finishedAt: null, taskCount: 1,
      results: [], visibility: 'hidden', parentChannel: 'sulla-desktop', parentThreadId: `${ suffix }-root`,
      tasks: [{ agentId: 'manager', label: 'manager', prompt: 'manage work', status: 'running', threadId: managerThread }] });
    const queryClient = { query: async(sql: string, params?: unknown[]) => database.query(sql, params) };
    const pending = new PendingDecisionRepository(queryClient as any);
    const holder = new DecisionHolderNotifier({
      sendJob: async() => ({ successBoolean: true, responseString: '{"queuedForNextBoundary":1}' }),
      enqueueChat: async() => true,
      canUseTool: async() => true,
      humanIsActive: async() => false,
      canSteer: async() => true,
    } as any);
    const decisions = new DecisionService(undefined, { pendingDecisions: pending as any, decisions: new HumanDecisionRepository(queryClient as any) as any,
      holderNotifier: holder as any, askerWaiter: { park: async() => undefined, parkQuestionAsker: async() => false } as any });
    const publisher = new BlockerDecisionPublisher(decisions);
    const childJobs = [0, 1, 2].map(index => `${ suffix }-child-job-${ index }`);
    const childThreads = childJobs.map((_job, index) => `${ suffix }-child-${ index }`);
    for (let index = 0; index < childJobs.length; index++) await jobs.insertJob({ jobId: childJobs[index], status: 'running', createdAt: Date.now(), finishedAt: null,
      taskCount: 1, results: [], visibility: 'hidden', parentChannel: 'sulla-desktop', parentThreadId: managerThread,
      tasks: [{ agentId: 'worker', label: `worker ${ index }`, prompt: 'work', status: 'running', threadId: childThreads[index] }] });

    const receipts = await Promise.all(childThreads.map((thread, index) => messages.appendCheckin(thread, {
      step: 'blocked', summary: 'Need a manager decision', blockers: [`choice ${ index }`],
    })));
    await Promise.all(receipts.map((receipt, index) => publisher.publish(receipt!, childThreads[index], 'sulla-desktop')));
    const records = await Promise.all(childJobs.map(jobId => pending.latestBlockerForTask(jobId, 0)));
    expect(records).toHaveLength(3);
    expect(new Set(records.map(record => record?.id)).size).toBe(3);
    expect(await decisions.openBlockerTaskKeys(childJobs)).toEqual(new Set(childJobs.map(jobId => `${ jobId }#0`)));
  });

  it('keeps the decision open and routes around a terminal parent without waking its dead task', async() => {
    // risk: liveness — a parent that has finished must not receive a stale job wake or destroy the child's pending decision.
    const suffix = `terminal-parent-blocker-${ Date.now() }`;
    const grandparentThread = `${ suffix }-grandparent`;
    const managerThread = `${ suffix }-manager`;
    const childThread = `${ suffix }-child`;
    const grandparentJob = `${ suffix }-grandparent-job`;
    const managerJob = `${ suffix }-manager-job`;
    const childJob = `${ suffix }-child-job`;
    await jobs.insertJob({ jobId: grandparentJob, status: 'running', createdAt: Date.now(), finishedAt: null, taskCount: 1,
      results: [], visibility: 'hidden', parentChannel: 'sulla-desktop', parentThreadId: `${ suffix }-root`,
      tasks: [{ agentId: 'lead', label: 'lead', prompt: 'lead', status: 'running', threadId: grandparentThread }] });
    await jobs.insertJob({ jobId: managerJob, status: 'running', createdAt: Date.now(), finishedAt: null, taskCount: 1,
      results: [], visibility: 'hidden', parentChannel: 'sulla-desktop', parentThreadId: grandparentThread,
      tasks: [{ agentId: 'manager', label: 'manager', prompt: 'manage', status: 'running', threadId: managerThread }] });
    await jobs.insertJob({ jobId: childJob, status: 'running', createdAt: Date.now(), finishedAt: null, taskCount: 1,
      results: [], visibility: 'hidden', parentChannel: 'sulla-desktop', parentThreadId: managerThread,
      tasks: [{ agentId: 'worker', label: 'worker', prompt: 'work', status: 'running', threadId: childThread }] });
    await database.query("UPDATE agent_jobs SET status='completed' WHERE job_id=$1", [managerJob]);

    const queryClient = { query: async(sql: string, params?: unknown[]) => database.query(sql, params) };
    const pending = new PendingDecisionRepository(queryClient as any);
    const delivered: Array<{ jobId: string; taskIndex: number; message: string }> = [];
    const holder = new DecisionHolderNotifier({
      sendJob: async(input) => { delivered.push(input); return { successBoolean: true, responseString: '{"queuedForNextBoundary":1}' }; },
      enqueueChat: async() => true,
      canUseTool: async() => true,
      humanIsActive: async() => false,
      canSteer: async() => true,
    } as any);
    const decisions = new DecisionService(undefined, { pendingDecisions: pending as any,
      decisions: new HumanDecisionRepository(queryClient as any) as any, holderNotifier: holder as any,
      askerWaiter: { park: async() => undefined, parkQuestionAsker: async() => false } as any });
    const publisher = new BlockerDecisionPublisher(decisions);
    const receipt = await messages.appendCheckin(childThread, { step: 'blocked', summary: 'Manager is gone', blockers: ['Need a decision'] });
    await publisher.publish(receipt!, childThread, 'sulla-desktop');
    const record = await pending.latestBlockerForTask(childJob, 0);
    expect(record?.status).toBe('pending');
    expect(record?.route?.chain[record.route.holderIndex]).toMatchObject({ threadId: grandparentThread, jobId: grandparentJob, kind: 'agent' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ jobId: grandparentJob, taskIndex: 0 });
    expect(delivered[0].jobId).not.toBe(managerJob);

    await database.query(`UPDATE agent_jobs SET tasks=jsonb_set(tasks, '{0,status}', '"completed"') WHERE job_id=$1`, [childJob]);
    expect((await pending.latestBlockerForTask(childJob, 0))?.status).toBe('pending');
    expect(await decisions.openBlockerTaskKeys([childJob])).toEqual(new Set([`${ childJob }#0`]));
  });
});
