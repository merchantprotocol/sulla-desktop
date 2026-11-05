// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentTaskReopenService } from '../../../app/Services/AgentTaskReopenService';
import { HiddenAgentTaskRunnerRegistry } from '../../../services/HiddenAgentTaskRunner';
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
    const inbox = { receive: vi.fn(async() => 'queued' as const) };
    const run = vi.fn(async() => ({ label: 'worker', status: 'completed' as const, output: 'fixed', threadId: 'thread-1' }));
    const runners = new HiddenAgentTaskRunnerRegistry();
    runners.register('job-1', 0, { run });
    const settlement = { settle: vi.fn(async() => undefined), fail: vi.fn(async() => undefined) };
    const service = new AgentTaskReopenService(jobs as any, history as any, inbox, runners, { now: () => new Date(10) } as any, settlement);

    const [first, second] = await Promise.all([
      service.reopen('job-1', 0, 'fix A', 'manager'),
      service.reopen('job-1', 0, 'fix B', 'manager'),
    ]);
    await new Promise(resolve => setImmediate(resolve));

    expect(first).toEqual({ reopened: true, generation: 2 });
    expect(second).toEqual({ reopened: true, generation: 2, joined: true });
    expect(run).toHaveBeenCalledTimes(1);
    const runCall = (run.mock.calls as Array<[{ threadId: string; generation: number }]>).at(0);
    expect(runCall).toBeDefined();
    if (!runCall) throw new Error('runner call was not recorded');
    expect(runCall[0]).toMatchObject({ threadId: 'thread-1', generation: 2 });
    expect(inbox.receive).toHaveBeenCalledTimes(2);
    expect(inbox.receive).toHaveBeenCalledWith(expect.objectContaining({ envelope: expect.objectContaining({ kind: 'parent', from: 'manager', body: 'fix A' }) }));
    expect(settlement.settle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stopped', 'stopped'], ['error', 'failed'], ['completed', 'limit_reached'],
  ] as const)('refuses %s without changing durable state', async(status, reason) => {
    // risk: unintended task replay
    const jobs = { job: vi.fn(async() => ({ ...job, tasks: [{ ...task, status, reopenCount: reason === 'limit_reached' ? 5 : 0 }] })), claimReopen: vi.fn() };
    const runners = new HiddenAgentTaskRunnerRegistry();
    runners.register('job-1', 0, { run: vi.fn() });
    const service = new AgentTaskReopenService(jobs as any, { forTask: vi.fn() } as any, { receive: vi.fn() }, runners, { now: () => new Date() } as any, { settle: vi.fn(), fail: vi.fn() });
    expect(await service.reopen('job-1', 0, 'retry', 'manager')).toEqual({ reopened: false, reason });
    expect(jobs.claimReopen).not.toHaveBeenCalled();
  });

  it('reconstructs the prompt on the same thread when the original runner is gone', async() => {
    // risk: lost provider session must not lose the manager's requested fix
    const jobs = { job: vi.fn(async() => ({ ...job, tasks: [{ ...task, result: { summary: 'first result' } }] })), claimReopen: vi.fn(async() => ({ generation: 2, leaseId: 'lease-2' })) };
    const inbox = { receive: vi.fn(async() => 'delivered' as const) };
    const service = new AgentTaskReopenService(jobs as any, { forTask: vi.fn(async() => []) } as any, inbox, new HiddenAgentTaskRunnerRegistry(), { now: () => new Date() } as any, { settle: vi.fn(), fail: vi.fn() });

    expect(await service.reopen('job-1', 0, 'fix the missing test', 'manager')).toEqual({ reopened: true, generation: 2, fallback: true });
    const receiveCall = (inbox.receive.mock.calls as Array<[{ target: { threadId?: string }; envelope: { body: string } }]>).at(0);
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
