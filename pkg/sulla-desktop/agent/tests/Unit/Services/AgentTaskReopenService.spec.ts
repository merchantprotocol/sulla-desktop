// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentTaskReopenService } from '../../../app/Services/AgentTaskReopenService';
import { HiddenTaskExecutionService } from '../../../services/HiddenAgentTaskRunner';
import { describe, expect, it, vi } from 'vitest';

const task = { agentId: 'codex-sol-worker', label: 'worker', prompt: 'do it', status: 'completed' as const, threadId: 'thread-1', generation: 1, reopenCount: 0 };
const job = { jobId: 'job-1', status: 'completed' as const, createdAt: 1, finishedAt: 2, taskCount: 1, results: [], tasks: [task], parentAgentId: 'manager', visibility: 'hidden' as const };

describe('AgentTaskReopenService', () => {
  it('claims once and launches the existing thread with parent feedback', async() => {
    // risk: duplicate external side effects
    let claimed = false;
    const jobs = {
      job: vi.fn(async() => claimed ? { ...job, status: 'running', tasks: [{ ...task, status: 'running', generation: 2, reopenCount: 1 }] } : job),
      claimReopen: vi.fn(async() => claimed ? undefined : (claimed = true, { generation: 2, leaseId: 'lease-2' })),
      releaseReopenLease: vi.fn(async() => true),
    };
    const history = { forTask: vi.fn(async() => [{ generation: 1 }]) };
    const inbox = { enqueue: vi.fn(async() => 'queued' as const) };
    const run = vi.fn(async() => ({ label: 'worker', status: 'completed' as const, output: 'fixed', threadId: 'thread-1' }));
    const runners = new HiddenTaskExecutionService({ execute: vi.fn(async(input: any) => ({ label: input.task.label, status: 'completed' as const, output: 'fresh', threadId: input.threadId })) });
    runners.register('job-1', 0, { run });
    const settlement = { settle: vi.fn(async() => undefined), fail: vi.fn(async() => undefined) };
    const service = new AgentTaskReopenService(jobs as any, history as any, inbox, runners, settlement);

    const [first, second] = await Promise.all([
      service.reopen('job-1', 0, 'fix A', 'manager'),
      service.reopen('job-1', 0, 'fix B', 'manager'),
    ]);
    await new Promise(resolve => setImmediate(resolve));

    expect(first).toEqual({ reopened: true, generation: 2 });
    expect(second).toEqual({ reopened: true, generation: 2, joined: true });
    expect(run).toHaveBeenCalledTimes(1);
    const runCall = (run.mock.calls as unknown as Array<[{ threadId: string; generation: number }]>).at(0);
    expect(runCall).toBeDefined();
    if (!runCall) throw new Error('runner call was not recorded');
    expect(runCall[0]).toMatchObject({ threadId: 'thread-1', generation: 2 });
    expect(inbox.enqueue).toHaveBeenCalledTimes(2);
    expect(inbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ envelope: expect.objectContaining({ kind: 'parent', from: 'manager', body: 'fix A' }) }));
    expect(settlement.settle).toHaveBeenCalledTimes(1);
  });


  it('persists feedback before execution and holds the lease until execution settles', async() => {
    // risk: lost manager feedback and overlapping generations
    let resolveRun!: (value: any) => void;
    const runPromise = new Promise<any>(resolve => { resolveRun = resolve; });
    const jobs = {
      job: vi.fn(async() => job), claimReopen: vi.fn(async() => ({ generation: 2, leaseId: 'lease-2' })),
      releaseReopenLease: vi.fn(async() => true),
    };
    const inbox = { enqueue: vi.fn(async() => 'queued' as const) };
    const run = vi.fn(() => runPromise);
    const execution = new HiddenTaskExecutionService({ execute: vi.fn() });
    execution.register('job-1', 0, { run });
    const settlement = { settle: vi.fn(async() => undefined), fail: vi.fn(async() => undefined) };
    const service = new AgentTaskReopenService(jobs as any, { forTask: vi.fn(async() => []) } as any, inbox, execution, settlement);

    await service.reopen('job-1', 0, 'fix', 'manager');
    expect(inbox.enqueue.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
    expect(jobs.releaseReopenLease).not.toHaveBeenCalled();
    resolveRun({ label: 'worker', status: 'completed', output: 'fixed', threadId: 'thread-1' });
    await new Promise(resolve => setImmediate(resolve));
    expect(settlement.settle).toHaveBeenCalledTimes(1);
    expect(jobs.releaseReopenLease).toHaveBeenCalledWith('job-1', 0, 2, 'lease-2');
  });

  it('does not execute when durable feedback enqueue fails', async() => {
    // risk: work executes without the manager correction
    const jobs = { job: vi.fn(async() => job), claimReopen: vi.fn(async() => ({ generation: 2, leaseId: 'lease-2' })), releaseReopenLease: vi.fn(async() => true) };
    const execute = vi.fn();
    const settlement = { settle: vi.fn(), fail: vi.fn(async() => undefined) };
    const service = new AgentTaskReopenService(jobs as any, { forTask: vi.fn(async() => []) } as any,
      { enqueue: vi.fn(async() => { throw new Error('database unavailable'); }) }, new HiddenTaskExecutionService({ execute }), settlement);
    await expect(service.reopen('job-1', 0, 'fix', 'manager')).rejects.toThrow('database unavailable');
    expect(execute).not.toHaveBeenCalled();
    expect(settlement.fail).toHaveBeenCalledTimes(1);
    expect(jobs.releaseReopenLease).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stopped', 'stopped'], ['error', 'failed'], ['completed', 'limit_reached'],
  ] as const)('refuses %s without changing durable state', async(status, reason) => {
    // risk: unintended task replay
    const jobs = { job: vi.fn(async() => ({ ...job, tasks: [{ ...task, status, reopenCount: reason === 'limit_reached' ? 5 : 0 }] })), claimReopen: vi.fn() };
    const runners = new HiddenTaskExecutionService({ execute: vi.fn(async(input: any) => ({ label: input.task.label, status: 'completed' as const, output: 'fresh', threadId: input.threadId })) });
    runners.register('job-1', 0, { run: vi.fn() });
    const service = new AgentTaskReopenService(jobs as any, { forTask: vi.fn() } as any, { enqueue: vi.fn() }, runners, { settle: vi.fn(), fail: vi.fn() });
    expect(await service.reopen('job-1', 0, 'retry', 'manager')).toEqual({ reopened: false, reason });
    expect(jobs.claimReopen).not.toHaveBeenCalled();
  });

  it('reconstructs the prompt on the same thread when the original runner is gone', async() => {
    // risk: lost provider session must not lose the manager's requested fix
    const jobs = { job: vi.fn(async() => ({ ...job, tasks: [{ ...task, result: { summary: 'first result' } }] })), claimReopen: vi.fn(async() => ({ generation: 2, leaseId: 'lease-2' })), releaseReopenLease: vi.fn(async() => true) };
    const inbox = { enqueue: vi.fn(async() => 'delivered' as const) };
    const service = new AgentTaskReopenService(jobs as any, { forTask: vi.fn(async() => []) } as any, inbox, new HiddenTaskExecutionService({ execute: vi.fn(async(input: any) => ({ label: input.task.label, status: 'completed' as const, output: 'fresh', threadId: input.threadId })) }), { settle: vi.fn(), fail: vi.fn() });

    expect(await service.reopen('job-1', 0, 'fix the missing test', 'manager')).toEqual({ reopened: true, generation: 2, fallback: true });
    const receiveCall = (inbox.enqueue.mock.calls as unknown as Array<[{ target: { threadId?: string }; envelope: { body: string } }]>).at(0);
    expect(receiveCall).toBeDefined();
    if (!receiveCall) throw new Error('inbox receive call was not recorded');
    const entry = receiveCall[0];
    expect(entry.target.threadId).toBe('thread-1');
    expect(entry.envelope.body).toContain('previous provider session or workspace was lost');
    expect(entry.envelope.body).toContain('do it');
    expect(entry.envelope.body).toContain('first result');
    expect(entry.envelope.body).toContain('fix the missing test');
  });
});
